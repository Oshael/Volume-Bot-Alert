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

function getWorkspaceHref(workspace: 'live' | 'history') {
  return workspace === 'history' ? '/monitor' : '/alerts';
}

function isPlainPrimaryClick(event: MouseEvent) {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}

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

function matchesMessage(
  message: string,
  options: { exact?: string[]; fragments?: string[]; noticeSet?: Set<string> },
) {
  return Boolean(
    options.noticeSet?.has(message)
    || options.exact?.includes(message)
    || options.fragments?.some((fragment) => message.includes(fragment)),
  );
}

function renderScopedFlash(
  state: AppState,
  options: {
    isError: (message: string) => boolean;
    isNotice: (message: string) => boolean;
  },
) {
  const message = state.ui.error ?? state.ui.notice ?? '';
  if (!message) {
    return '';
  }

  const isScopedError = options.isError(message);
  const isScopedNotice = options.isNotice(message);
  if (!isScopedError && !isScopedNotice) {
    return '';
  }

  return renderFlash({
    ...state,
    ui: {
      ...state.ui,
      error: isScopedError ? state.ui.error : null,
      notice: isScopedNotice ? state.ui.notice : null,
    },
  });
}

function isRegisterFlashErrorMessage(message: string) {
  return matchesMessage(message, {
    exact: [
      'Username is required.',
      'Username must be at least 3 characters.',
      'Username must be 3-32 characters and use only letters, numbers, or underscores.',
      'Username already taken',
      'Email is required.',
      'Enter a valid email address.',
      'Email already registered',
      'Invalid email format',
      'Password is required.',
      'Password must be at least 8 characters.',
      'Password must be 8-128 characters.',
      'Please confirm your password.',
      'The passwords do not match. Please check them and try again.',
      'Invite code is required.',
    ],
    fragments: [
      'Invite',
      'invite',
      'registered',
      'Internal server error',
      'Unable to reach the server',
    ],
  });
}

function isPasswordResetFlashErrorMessage(message: string) {
  return matchesMessage(message, {
    exact: [
      'Email is required.',
      'Enter a valid email address.',
      'Reset link is missing or invalid.',
      'New password is required.',
      'New password must be at least 8 characters.',
      'New password must be 8-128 characters.',
      'Please confirm the new password.',
      'The new passwords do not match. Please check them and try again.',
    ],
    fragments: [
      'Reset token is invalid or expired',
      'Reset token is invalid or already used',
      'Password reset request failed',
      'Password reset failed',
      'not verified',
      'verification email could not be sent',
      'Internal server error',
      'Unable to reach the server',
    ],
  });
}

function isPasswordResetFlashNoticeMessage(message: string) {
  return matchesMessage(message, {
    noticeSet: PASSWORD_RESET_TRANSIENT_NOTICES,
    fragments: [
      'password reset link has been sent',
      'verification link has been sent',
      'Check your inbox to verify your email',
      'Password reset successful',
    ],
  });
}

function isLoginOtpFlashErrorMessage(message: string) {
  return matchesMessage(message, {
    exact: [
      'Verification challenge is missing. Please sign in again.',
      'Verification code is required.',
      'Enter the 6-digit verification code.',
    ],
    fragments: [
      'Verification code is incorrect',
      'Verification code is invalid or expired',
      'Too many invalid verification attempts',
      'Unable to reach the server',
      'Internal server error',
    ],
  });
}

function isLoginOtpFlashNoticeMessage(message: string) {
  return matchesMessage(message, {
    noticeSet: LOGIN_OTP_TRANSIENT_NOTICES,
    fragments: [
      'Verification code sent',
      'A new verification code has been sent',
    ],
  });
}

function isDashboardLoginOnlyMessage(message: string) {
  return matchesMessage(message, {
    noticeSet: LOGIN_RELEVANT_NOTICES,
    exact: [
      'Incorrect email or password. Check your credentials and try again.',
      'Email is required.',
      'Enter a valid email address.',
      'Password is required.',
    ],
    fragments: ['old password changed on'],
  });
}

function isDashboardRegisterOnlyMessage(message: string) {
  return matchesMessage(message, {
    noticeSet: REGISTER_TRANSIENT_NOTICES,
    exact: [
      'Username is required.',
      'Username must be at least 3 characters.',
      'Username must be 3-32 characters and use only letters, numbers, or underscores.',
      'Username already taken',
      'Email already registered',
      'Invalid email format',
      'Password must be 8-128 characters.',
      'Please confirm your password.',
      'The passwords do not match. Please check them and try again.',
      'Invite code is required.',
    ],
    fragments: ['Invite', 'invite', 'registered'],
  });
}

function isDashboardChangePasswordOnlyMessage(message: string) {
  return isChangePasswordErrorMessage(message)
    || isChangePasswordNoticeMessage(message)
    || CHANGE_PASSWORD_TRANSIENT_NOTICES.has(message);
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
  { key: 'alert-recent-surge-1h-enabled', label: 'RECENT SURGE 1H' },
  { key: 'alert-recent-surge-6h-enabled', label: 'RECENT SURGE 6H' },
  { key: 'alert-old-week-surge-1h-enabled', label: 'OLD SURGE 1H' },
  { key: 'alert-old-week-surge-6h-enabled', label: 'OLD SURGE 6H' },
  { key: 'alert-meteora-surge-enabled', label: 'METEORA 1H' },
  { key: 'alert-pumpfun-vol-enabled', label: 'PUMPFUN VOL' },
  { key: 'alert-pumpfun-hvnc-enabled', label: 'PUMPFUN HVNC' },
  { key: 'alert-high-cap-dump-enabled', label: 'HIGH CAP DUMP 5M' },
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
  { key: 'sound-high-cap-dump-enabled', label: 'HIGH CAP DUMP 5M' },
] as const;

const SAFETY_TOGGLE_FIELDS = [
  { key: 'block-warning-enabled', label: 'BLOCK TOKEN WARNING' },
] as const;

export function renderLegacyShell(state: AppState, controller: AppController) {
  const wrapper = document.createElement('section');
  wrapper.className = 'legacy-shell';
  const pathname = typeof window !== 'undefined' ? window.location.pathname || '/' : '/';

  if (state.session.status === 'loading') {
    wrapper.append(renderLegacyBootstrap(state));
    return wrapper;
  }

  if (state.session.status === 'pre_access') {
    if (pathname === '/account-security' || pathname.startsWith('/account-security/')) {
      wrapper.append(renderAccountSecurityFlow(state, controller));
      return wrapper;
    }
    wrapper.append(renderPreAccessFlow(state, controller));
    return wrapper;
  }

  if (state.session.status === 'authenticated' && (pathname === '/account-security' || pathname.startsWith('/account-security/'))) {
    wrapper.append(renderAccountSecurityFlow(state, controller));
    return wrapper;
  }

  if (state.session.status !== 'authenticated') {
    if (pathname === '/') {
      wrapper.append(renderPublicLanding(state, controller));
      return wrapper;
    }
    wrapper.append(renderLegacyLogin(state, controller));
    return wrapper;
  }

  wrapper.append(renderLegacyActions(state, controller));

  return wrapper;
}

function renderAccountSecurityFlow(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  const isPreAccess = state.session.status === 'pre_access';
  const returnLabel = isPreAccess ? 'BACK TO ACCESS' : 'BACK TO BOT';

  section.className = 'legacy-login-shell legacy-pre-access-shell legacy-account-security-shell';
  section.innerHTML = `
    <div class="legacy-pre-access-landing">
      <div class="legacy-pre-access-topbar">
        <div class="legacy-pre-access-brand">
          <img class="workspace-brand-mark" src="${SITE_LOGO_URL}" alt="TrendScope logo" />
          <div class="legacy-pre-access-brand-copy">
            <strong>TrendScope</strong>
            <span>Account Settings</span>
          </div>
        </div>
        <div class="legacy-pre-access-topbar-actions">
          <button type="button" class="legacy-userbar-link" data-action="return-from-account-security">${returnLabel}</button>
          <button type="button" class="legacy-userbar-link" data-action="logout-account-security" ${state.ui.busy ? 'disabled' : ''}>LOGOUT</button>
        </div>
      </div>

      <div class="legacy-pre-access-hero-shell legacy-account-security-hero-shell">
        <div class="legacy-pre-access-hero-panel legacy-account-security-hero-panel">
          <div class="legacy-pre-access-hero-copy legacy-account-security-hero-copy">
            <span class="legacy-pre-access-eyebrow">Limited Security Surface</span>
            <h1>Review linked login methods.</h1>
            <p>This limited route exists so you can unlink social login methods and review checkout history even when you no longer have access to the live bot surface.</p>
            ${state.ui.error ? `<div class="legacy-auth-panel-note" data-state="error">${escapeHtml(state.ui.error)}</div>` : ''}
            ${state.ui.notice ? `<div class="legacy-auth-panel-note">${escapeHtml(state.ui.notice)}</div>` : ''}
          </div>
        </div>
      </div>

      <section class="legacy-pre-access-history-section">
        <div class="legacy-user-settings-grid">
          ${renderAccountAccessSummaryCard(state)}
          ${renderUserLinkedIdentitiesCard(state, { allowConnectActions: false, allowUnlinkActions: true })}
          ${renderAccountSecurityOrdersCard(state)}
        </div>
      </section>
    </div>
  `;

  section.querySelector<HTMLButtonElement>('[data-action="return-from-account-security"]')?.addEventListener('click', () => {
    if (isPreAccess) {
      controller.goToPreAccess();
      return;
    }

    controller.setWorkspace(state.ui.workspace);
  });
  section.querySelector<HTMLButtonElement>('[data-action="logout-account-security"]')?.addEventListener('click', () => {
    void controller.logout();
  });
  section.querySelectorAll<HTMLButtonElement>('[data-action="resume-account-security-checkout"]').forEach((button) => {
    button.addEventListener('click', () => {
      const checkoutUrl = String(button.dataset.checkoutUrl || '').trim();
      if (!checkoutUrl || typeof window === 'undefined') {
        return;
      }
      window.location.href = checkoutUrl;
    });
  });
  bindLinkedIdentityActions(section, controller);

  return section;
}

function renderPublicLanding(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  const billingUnavailableMessage = !state.billing.loaded
    ? 'Loading access plans...'
    : !state.billing.enabled
      ? 'Billing is disabled in this environment.'
      : !state.billing.providerReady
        ? 'MoonPay Commerce credentials are not configured yet.'
        : state.billing.plans.length === 0
          ? 'No billing plans are configured yet.'
          : null;
  const recommendedPlanKey = state.billing.plans
    .slice()
    .sort((left, right) => (right.accessDays || 0) - (left.accessDays || 0))[0]?.key ?? null;
  const shortestPlan = state.billing.plans
    .slice()
    .sort((left, right) => (left.accessDays || 0) - (right.accessDays || 0))[0] ?? null;

  section.className = 'legacy-login-shell legacy-pre-access-shell legacy-public-shell';
  section.innerHTML = `
    <div class="legacy-pre-access-landing legacy-public-landing">
      <div class="legacy-pre-access-topbar legacy-public-topbar">
        <div class="legacy-pre-access-brand">
          <img class="workspace-brand-mark" src="${SITE_LOGO_URL}" alt="TrendScope logo" />
          <div class="legacy-pre-access-brand-copy">
            <strong>TrendScope</strong>
            <span>Volume Bot Access</span>
          </div>
        </div>
        <div class="legacy-pre-access-topbar-actions legacy-public-topbar-actions">
          <button type="button" class="legacy-userbar-link legacy-public-login-btn" data-action="open-login-page">Login</button>
          <button type="button" class="legacy-btn legacy-btn-primary legacy-public-register-btn" data-action="open-register-page">Create Account</button>
        </div>
      </div>

      <div class="legacy-pre-access-hero-shell legacy-public-hero-shell">
        <div class="legacy-pre-access-hero-panel legacy-public-hero-panel">
          <div class="legacy-pre-access-hero-copy legacy-public-hero-copy">
            <span class="legacy-pre-access-eyebrow legacy-public-eyebrow">Solana Volume Tracking</span>
            <h1>Catch <span class="legacy-public-hero-emphasis">volume spikes</span> before the crowd moves.</h1>
            <p>TrendScope monitors fast Solana volume shifts, migration flow, and account-bound watchlists from one live workspace built for operators, not spectators.</p>
            <div class="legacy-pre-access-hero-actions legacy-public-hero-actions">
              <button type="button" class="legacy-pre-access-secondary-btn legacy-public-hero-secondary" data-action="focus-public-plans">VIEW PRICING</button>
            </div>
            ${state.ui.error && state.ui.error !== 'Authentication required' ? `<div class="legacy-auth-panel-note" data-state="error">${escapeHtml(state.ui.error)}</div>` : ''}
            ${state.ui.notice && state.ui.notice !== 'No saved session. Sign in to continue.' ? `<div class="legacy-auth-panel-note">${escapeHtml(state.ui.notice)}</div>` : ''}
          </div>
        </div>
      </div>

      <section class="legacy-public-stats-section">
        <div class="legacy-public-stat-grid">
          ${renderPublicLandingStatTiles()}
        </div>
      </section>

      <section class="legacy-pre-access-benefits legacy-public-features-section" data-role="benefits-section">
        <div class="legacy-pre-access-section-head legacy-public-section-head">
          <span class="legacy-pre-access-section-kicker">Inside The Bot</span>
          <h2>What you get in the<br />workspace</h2>
          <p>A tighter monitoring surface for spotting movement, filtering noise, and keeping operational context attached to the same account.</p>
        </div>
        <div class="legacy-pre-access-feature-grid legacy-public-feature-grid">
          ${renderPublicLandingFeatureTiles()}
        </div>
      </section>

      <section class="legacy-pre-access-plans-section legacy-public-pricing-section" data-role="public-billing-plans-card">
        <div class="legacy-pre-access-section-head legacy-public-section-head">
          <span class="legacy-pre-access-section-kicker">Choose Your Access</span>
          <h2>Pick the plan that fits<br />your testing window</h2>
          <p>Shorter plans are better for validating workflow and alerts. Longer plans reduce renewal friction once the setup is already part of your routine.</p>
        </div>
        ${state.billing.providerMocked ? `
          <div class="legacy-auth-panel-note">Local billing mock mode is active in this environment.</div>
        ` : ''}
        ${state.billing.error ? `
          <div class="legacy-auth-panel-note" data-state="error">${escapeHtml(state.billing.error)}</div>
        ` : ''}
        ${billingUnavailableMessage ? `
          <div class="legacy-auth-panel-note">${escapeHtml(billingUnavailableMessage)}</div>
        ` : `
          <div class="legacy-billing-plan-grid legacy-public-pricing-grid">
            ${state.billing.plans.map((plan) => {
              const recommended = recommendedPlanKey === plan.key;
              const dailyRate = formatBillingDailyRate(plan.amountMinor, plan.accessDays);
              const shortestDailyRate = shortestPlan ? formatBillingDailyRate(shortestPlan.amountMinor, shortestPlan.accessDays) : null;
              return `
                <div class="legacy-billing-plan-card legacy-pre-access-plan-card legacy-public-pricing-card ${recommended ? 'featured recommended' : ''}">
                  ${recommended ? `<span class="legacy-public-plan-floating-badge">Best value</span>` : ''}
                  <div class="legacy-pre-access-plan-topline legacy-public-plan-topline">
                    <span class="legacy-pre-access-plan-badge">Access plan</span>
                    <span class="legacy-pre-access-plan-duration">${plan.accessDays} day${plan.accessDays === 1 ? '' : 's'}</span>
                  </div>
                  <div class="legacy-billing-plan-copy legacy-public-plan-copy">
                    <strong>${escapeHtml(plan.label)}</strong>
                    <span>${escapeHtml(plan.description || `${plan.accessDays} days of product access`)}</span>
                  </div>
                  <div class="legacy-public-plan-price-row">
                    <span>${escapeHtml(String(plan.currencyCode || '').trim().toUpperCase())}</span>
                    <strong class="legacy-billing-plan-price legacy-public-plan-price">${escapeHtml(formatBillingMajorAmount(plan.amountMinor))}</strong>
                  </div>
                  <div class="legacy-billing-plan-meta legacy-public-plan-meta">${plan.available ? 'Account-bound checkout starts after login' : escapeHtml(plan.availabilityReason || 'Unavailable')}</div>
                  ${recommended && dailyRate && shortestDailyRate && shortestPlan && shortestPlan.key !== plan.key ? `
                    <div class="legacy-public-plan-value-line">~${escapeHtml(dailyRate)} vs ${escapeHtml(shortestDailyRate)} on ${escapeHtml(shortestPlan.label.toLowerCase())}</div>
                  ` : ''}
                  <div class="legacy-auth-panel-actions legacy-user-settings-actions">
                    <button type="button" class="legacy-btn ${recommended ? 'legacy-btn-primary' : 'legacy-public-plan-ghost-btn'}" data-action="open-login-page">LOGIN TO BUY</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
        <div class="legacy-public-pricing-trust-line">Payment via USDC on Solana · Access activates after payment confirmation · No recurring charges</div>
      </section>
    </div>
  `;

  section.querySelectorAll<HTMLButtonElement>('[data-action="open-login-page"]').forEach((button) => {
    button.addEventListener('click', () => controller.goToLogin());
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-register-page"]')?.addEventListener('click', () => {
    controller.goToLogin('register');
  });
  section.querySelector<HTMLButtonElement>('[data-action="focus-public-plans"]')?.addEventListener('click', () => {
    section.querySelector<HTMLElement>('[data-role="public-billing-plans-card"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  return section;
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
  const shouldHideDefaultPreAccessNotice = state.ui.notice === 'Access payment required before entering the bot.';

  section.className = 'legacy-login-shell legacy-pre-access-shell';
  section.innerHTML = `
    <div class="legacy-pre-access-landing legacy-public-landing">
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
          <button type="button" class="legacy-userbar-link legacy-public-login-btn legacy-pre-access-topbar-btn" data-action="open-account-security">ACCOUNT SETTINGS</button>
          <button type="button" class="legacy-btn legacy-public-register-btn legacy-pre-access-logout-btn" data-action="logout-pre-access" ${state.ui.busy ? 'disabled' : ''}>LOGOUT</button>
        </div>
      </div>

      ${state.ui.error ? `<div class="legacy-auth-panel-note" data-state="error">${escapeHtml(state.ui.error)}</div>` : ''}
      ${state.ui.notice && !shouldHideDefaultPreAccessNotice ? `<div class="legacy-auth-panel-note">${escapeHtml(state.ui.notice)}</div>` : ''}
      ${ready ? `
        <div class="legacy-auth-panel-note">Payment confirmed for this account. You can enter the bot now.</div>
      ` : waiting ? `
        <div class="legacy-auth-panel-note">Payment returned from checkout. We are still waiting for backend confirmation before opening the bot.</div>
      ` : ''}

      <section class="legacy-pre-access-plans-section legacy-public-pricing-section">
        <div class="legacy-pre-access-section-head legacy-public-section-head">
          <span class="legacy-pre-access-section-kicker">Choose Your Access</span>
          <h2>Pick the plan that fits<br />your testing window</h2>
          <p>Choose the access window for this authenticated account and continue with the checkout flow below.</p>
        </div>
        ${renderPreAccessPlansCard(state)}
      </section>
    </div>
  `;

  section.querySelector<HTMLButtonElement>('[data-action="complete-pre-access"]')?.addEventListener('click', () => {
    void controller.completePreAccess();
  });
  section.querySelector<HTMLButtonElement>('[data-action="logout-pre-access"]')?.addEventListener('click', () => {
    void controller.logout();
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-account-security"]')?.addEventListener('click', () => {
    controller.goToAccountSecurity();
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
      window.open(checkoutUrl, '_blank', 'noopener');
    });
  });

  return section;
}

function renderPublicLandingStatTiles() {
  const stats = [
    {
      value: '24/7',
      label: 'Monitoring coverage',
      detail: 'Built around a continuously running monitoring workspace.',
    },
    {
      value: '2s',
      label: 'Refresh cadence',
      detail: 'The current monitored loop is tuned around a 2-second cycle, not a marketing-only latency claim.',
    },
    {
      value: 'USDC',
      label: 'Billing rail',
      detail: 'Access plans are configured around USDC billing in the current setup.',
    },
  ];

  return stats.map((stat) => `
    <article class="legacy-public-stat-card">
      <strong>${escapeHtml(stat.value)}</strong>
      <span>${escapeHtml(stat.label)}</span>
    </article>
  `).join('');
}

function renderPublicFeatureIcon(icon: 'pulse' | 'history' | 'migration' | 'watchlist' | 'panels' | 'workflow') {
  if (icon === 'history') {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M13 3a9 9 0 1 0 8.95 10h-2.02A7 7 0 1 1 13 5V1l5 4-5 4V3Zm-1 5h2v5.2l3.4 2.04-1 1.64L12 14.2V8Z"/>
      </svg>
    `;
  }
  if (icon === 'migration') {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M4 6h10l-2.3-2.29L13.11 2 18 6.89 13.11 12l-1.41-1.41L14 8H4V6Zm16 12H10l2.29 2.29L10.89 22 6 17.11 10.89 12l1.4 1.41L10 16h10v2Z"/>
      </svg>
    `;
  }
  if (icon === 'watchlist') {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z"/>
      </svg>
    `;
  }
  if (icon === 'panels') {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M3 3h8v8H3V3Zm10 0h8v5h-8V3ZM3 13h5v8H3v-8Zm7 0h11v8H10v-8Z"/>
      </svg>
    `;
  }
  if (icon === 'workflow') {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M5 4h14v4H5V4Zm0 6h14v4H5v-4Zm0 6h9v4H5v-4Zm11 0h3v4h-3v-4Z"/>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="m3 17 4.5-4.5 3 3L17 9l4 4v5H3v-1Zm0-10h4v6H3V7Zm7-3h4v9h-4V4Zm7 5h4v4h-4V9Z"/>
    </svg>
  `;
}

function renderPublicLandingFeatureTiles() {
  const features = [
    {
      icon: 'pulse' as const,
      title: 'Real-Time Volume Alerts',
      body: 'Surface sudden volume and market-cap movement without living inside manual scanners all day.',
    },
    {
      icon: 'history' as const,
      title: 'Historical Monitor View',
      body: 'Review what happened after the first alert instead of trading off a single raw spike.',
    },
    {
      icon: 'migration' as const,
      title: 'PumpFun Migration Signals',
      body: 'Keep migration-related movement in the same workspace when meme flow starts rotating fast.',
    },
    {
      icon: 'watchlist' as const,
      title: 'Personal Watchlists',
      body: 'Attach manual lists, blocklists, and workspace preferences directly to the account.',
    },
    {
      icon: 'panels' as const,
      title: 'Meteora And Side Panels',
      body: 'Use side panels and richer token context instead of making calls from one bare alert row.',
    },
    {
      icon: 'workflow' as const,
      title: 'Operational Workflow',
      body: 'Built as an operator console with account-bound access, not just a passive notification feed.',
    },
  ];

  return features.map((feature) => `
    <article class="legacy-pre-access-feature-card legacy-public-feature-card">
      <span class="legacy-public-feature-icon" aria-hidden="true">${renderPublicFeatureIcon(feature.icon)}</span>
      <strong>${escapeHtml(feature.title)}</strong>
      <p>${escapeHtml(feature.body)}</p>
    </article>
  `).join('');
}

function renderAccountSecurityOrdersCard(state: AppState) {
  const heading = state.session.status === 'pre_access'
    ? 'Checkout History'
    : 'Billing History';
  const copy = state.session.status === 'pre_access'
    ? 'Recent checkout attempts and confirmed payments for this account outside the bot workspace.'
    : 'Recent billing orders and completed payments linked to this account.';

  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide legacy-pre-access-orders-card">
      <div class="legacy-user-settings-card-head legacy-pre-access-card-head">
        <strong>${escapeHtml(heading)}</strong>
        <span>${escapeHtml(copy)}</span>
      </div>
      ${state.billing.orders.length === 0 ? `
        <div class="legacy-auth-panel-note">No billing orders yet.</div>
      ` : `
        <div class="legacy-billing-order-list">
          ${state.billing.orders.map((order) => `
            <div class="legacy-billing-order-row">
              <div class="legacy-billing-order-main">
                <strong>${escapeHtml(order.planName)}</strong>
                <span>${escapeHtml(formatBillingAmount(order.currencyCode, order.currencyAmountMinor))}</span>
              </div>
              <div class="legacy-billing-order-side">
                <span>${escapeHtml(getBillingOrderStatusLabel(order.status))}</span>
                <span>${escapeHtml(order.paidAt ? formatDateTime(order.paidAt) : formatDateTime(order.createdAt))}</span>
                ${order.status === 'paid' ? `
                  <a
                    class="legacy-userbar-link"
                    href="${escapeHtml(getBillingReceiptUrl(order.id))}"
                    target="_blank"
                    rel="noopener"
                  >Receipt</a>
                ` : ''}
                ${order.providerCheckoutUrl && order.status !== 'paid' ? `
                  <button type="button" class="legacy-userbar-link" data-action="resume-account-security-checkout" data-checkout-url="${escapeHtml(order.providerCheckoutUrl)}">Resume Checkout</button>
                ` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

function getWorkspaceConnectionState(state: AppState) {
  if (state.session.status !== 'authenticated' || state.runtime.mode === 'stopped') {
    return { tone: 'disconnected', label: 'Disconnected' };
  }

  if (state.runtime.mode === 'syncing') {
    return { tone: 'unstable', label: 'Unstable' };
  }

  const monitoredUpdatedAt = state.runtime.monitoredUpdatedAt;
  const monitoredAgeMs = monitoredUpdatedAt ? (Date.now() - new Date(monitoredUpdatedAt).getTime()) : Number.POSITIVE_INFINITY;
  const hasFreshMonitoring = Number.isFinite(monitoredAgeMs) && monitoredAgeMs >= 0 && monitoredAgeMs <= 15_000;
  const expectsPumpSocket = state.ui.workspace === 'live';
  const hasExpectedPumpConnection = !expectsPumpSocket || state.pumpfun.connected;

  if (!hasFreshMonitoring || !hasExpectedPumpConnection) {
    return { tone: 'unstable', label: 'Unstable' };
  }

  return { tone: 'connected', label: 'Connected' };
}

export function renderWorkspaceHeader(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-topbar workspace-topbar';
  const isLiveWorkspace = state.ui.workspace === 'live';
  const isHistoryWorkspace = state.ui.workspace === 'history';
  const connectionState = getWorkspaceConnectionState(state);
  section.innerHTML = `
    <div class="workspace-topbar-inner">
      <div class="workspace-brand">
        <img class="workspace-brand-mark" src="${SITE_LOGO_URL}" alt="TrendScope logo" />
        <div class="workspace-brand-copy">
          <strong class="workspace-brand-title">TrendScope</strong>
          <span class="workspace-brand-sub">Volume Bot Tracker</span>
          <div class="workspace-connection-status" data-state="${connectionState.tone}">
            <span class="workspace-connection-dot" aria-hidden="true"></span>
            <span class="workspace-connection-label">${connectionState.label}</span>
          </div>
        </div>
      </div>
      <div class="workspace-route-group">
        <div class="workspace-route-nav" aria-label="Workspace navigation">
          <a href="${getWorkspaceHref('live')}" class="workspace-route-btn ${isLiveWorkspace ? 'active' : ''}" data-action="open-workspace-live">ALERTS</a>
          <a href="${getWorkspaceHref('history')}" class="workspace-route-btn ${isHistoryWorkspace ? 'active' : ''}" data-action="open-workspace-history">MONITOR</a>
        </div>
        <div class="workspace-layout-reset" data-role="layout-reset">
          <button type="button" class="workspace-layout-reset-btn" data-action="reset-live-panel-layout" aria-label="Reset bot layout">
            <span aria-hidden="true">↺</span>
          </button>
          <div class="workspace-layout-reset-tooltip" role="tooltip">
            ${escapeHtml('Isso reseta o layout do bot para as configurações visuais padrões')}
          </div>
        </div>
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
  section.querySelector<HTMLAnchorElement>('[data-action="open-workspace-live"]')?.addEventListener('click', (event) => {
    if (!isPlainPrimaryClick(event)) {
      return;
    }
    event.preventDefault();
    controller.setWorkspace('live');
  });
  section.querySelector<HTMLAnchorElement>('[data-action="open-workspace-history"]')?.addEventListener('click', (event) => {
    if (!isPlainPrimaryClick(event)) {
      return;
    }
    event.preventDefault();
    controller.setWorkspace('history');
  });
  bindWorkspaceLayoutResetActions(section, controller);
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

function bindWorkspaceLayoutResetActions(section: HTMLElement, controller: AppController) {
  const resetWrap = section.querySelector<HTMLElement>('[data-role="layout-reset"]');
  const resetButton = section.querySelector<HTMLButtonElement>('[data-action="reset-live-panel-layout"]');
  if (!resetButton) {
    return;
  }

  let resetTooltipTimer = 0;
  const showResetTooltip = () => {
    window.clearTimeout(resetTooltipTimer);
    resetTooltipTimer = window.setTimeout(() => {
      resetWrap?.setAttribute('data-tooltip-visible', 'true');
    }, 700);
  };
  const hideResetTooltip = () => {
    window.clearTimeout(resetTooltipTimer);
    resetWrap?.removeAttribute('data-tooltip-visible');
  };

  resetButton.addEventListener('click', () => {
    hideResetTooltip();
    controller.resetLivePanelLayout();
  });
  resetButton.addEventListener('pointerenter', showResetTooltip);
  resetButton.addEventListener('pointerleave', hideResetTooltip);
  resetButton.addEventListener('focus', showResetTooltip);
  resetButton.addEventListener('blur', hideResetTooltip);
}

export function renderWorkspaceProfileOverlay(state: AppState, controller: AppController) {
  const hasBlockTokenWarning = state.session.status === 'authenticated' && Boolean(state.ui.blockTokenWarning);
  if (!isProfileAuthPanel(state.ui.authPanel) && !hasBlockTokenWarning) {
    return null;
  }

  const overlay = document.createElement('div');
  overlay.className = 'workspace-profile-overlay-root';
  if (state.ui.authPanel === 'user-settings') {
    overlay.innerHTML = renderUserSettingsModal(state);
    bindProfileModalCloseActions(overlay, controller);
    bindUserSettingsPanel(overlay, controller);
    return overlay;
  }

  if (state.ui.authPanel === 'bot-settings') {
    overlay.innerHTML = renderBotSettingsModal(state);
    bindProfileModalCloseActions(overlay, controller);
    bindBotSettingsPanel(overlay, controller, state);
    return overlay;
  }

  if (state.ui.authPanel === 'blocked-tokens') {
    overlay.innerHTML = renderBlockedTokensModal(state);
    bindProfileModalCloseActions(overlay, controller);
    bindBlockedTokensPanel(overlay, controller);
    return overlay;
  }

  if (hasBlockTokenWarning) {
    overlay.innerHTML = renderBlockTokenWarningModal(state);
    bindBlockTokenWarningModal(overlay, controller);
    return overlay;
  }

  overlay.innerHTML = renderChangePasswordModal(state);
  bindProfileModalCloseActions(overlay, controller);
  bindChangePasswordPanel(overlay, controller, state);
  return overlay;
}

function bindProfileModalCloseActions(section: ParentNode, controller: AppController) {
  section.querySelectorAll<HTMLElement>('[data-action="close-profile-modal"]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      controller.closeAuthPanel();
    });
  });
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

function renderBlockTokenWarningModal(state: AppState) {
  const warning = state.ui.blockTokenWarning;
  if (!warning) {
    return '';
  }

  const label = warning.label || warning.address.slice(0, 8);
  return `
    <div class="legacy-auth-modal" data-auth-modal="block-token-warning" data-auth-modal-scope="block-warning">
      <div class="legacy-auth-modal-backdrop" data-action="close-block-token-warning"></div>
      <div class="legacy-auth-panel legacy-auth-panel-block-warning" data-auth-panel="block-token-warning" role="dialog" aria-modal="true" aria-labelledby="block-token-warning-title">
        <div class="legacy-block-warning-head">
          <strong id="block-token-warning-title" class="legacy-block-warning-title">Block token</strong>
          <button type="button" class="legacy-block-warning-close" data-action="close-block-token-warning" aria-label="Close dialog">X</button>
        </div>
        <div class="legacy-block-warning-copy">Hide <strong>${escapeHtml(label)}</strong> from your workspace and stop all alerts for this token.</div>
        <div
          class="legacy-block-warning-address"
          title="${escapeHtml(warning.address)}"
        >${escapeHtml(warning.address)}</div>
        <div class="legacy-block-warning-footer">
          <label class="legacy-block-warning-toggle">
            <input
              type="checkbox"
              data-action="toggle-block-token-warning-skip"
              ${warning.dontShowAgain ? 'checked' : ''}
              ${state.ui.busy ? 'disabled' : ''}
            />
            <span>Don't warn again</span>
          </label>
          <div class="legacy-block-warning-actions">
            <button type="button" class="legacy-block-warning-button legacy-block-warning-button-cancel" data-action="cancel-block-token-warning" ${state.ui.busy ? 'disabled' : ''}>Cancel</button>
            <button type="button" class="legacy-block-warning-button legacy-block-warning-button-danger" data-action="confirm-block-token-warning" ${state.ui.busy ? 'disabled' : ''}>Block</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bindBlockTokenWarningModal(section: ParentNode, controller: AppController) {
  const panel = section.querySelector<HTMLElement>('[data-auth-panel="block-token-warning"]');
  if (!panel) {
    return;
  }

  bindFocusTrap(panel);

  section.querySelectorAll<HTMLElement>('[data-action="close-block-token-warning"], [data-action="cancel-block-token-warning"]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void controller.cancelBlockedTokenWarning();
    });
  });

  section.querySelector<HTMLInputElement>('[data-action="toggle-block-token-warning-skip"]')?.addEventListener('change', (event) => {
    const target = event.currentTarget as HTMLInputElement | null;
    controller.setBlockedTokenWarningDontShowAgain(Boolean(target?.checked));
  });

  section.querySelector<HTMLButtonElement>('[data-action="confirm-block-token-warning"]')?.addEventListener('click', () => {
    void controller.confirmBlockedTokenWarning();
  });
}

function renderLegacyLogin(state: AppState, controller: AppController) {
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
    ${renderLegacyAuthPanels(state)}
  `;
  hydrateAuthSensitiveText(section, state);

  const form = section.querySelector<HTMLFormElement>('form[data-role="login-form"]');
  bindLegacyLoginForm(section, form, state, controller);
  bindLegacyLoginActions(section, state, controller);
  bindRegisterPanel(section, controller, state);
  bindEmailVerificationPanel(section, controller, state);
  bindEmailOtpPanel(section, controller, state);
  bindEmailVerifiedSuccessPanel(section, controller);
  bindPasswordChangeSuccessPanel(section, controller);
  bindInviteAssistancePanel(section, controller, state);
  bindPasswordResetPanel(section, controller, state);
  return section;
}

function renderLegacyAuthPanels(state: AppState) {
  return [
    state.ui.authPanel === 'register' ? renderRegisterModal(state) : '',
    state.ui.authPanel === 'email-verification' ? renderEmailVerificationModal(state) : '',
    state.ui.authPanel === 'email-verified-success' ? renderEmailVerifiedSuccessModal() : '',
    state.ui.authPanel === 'password-change-success' ? renderPasswordChangeSuccessModal() : '',
    state.ui.authPanel === 'invite-assistance' ? renderInviteAssistanceModal(state) : '',
    state.ui.authPanel === 'password-reset' ? renderPasswordResetModal(state) : '',
    state.ui.authPanel === 'email-otp' ? renderEmailOtpModal(state) : '',
  ].join('');
}

function bindLegacyLoginForm(
  section: HTMLElement,
  form: HTMLFormElement | null,
  state: AppState,
  controller: AppController,
) {
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

  bindLegacyPasswordVisibility(form);
  bindLegacyLoginInputs(section, form, state, controller, submitLoginForm);
}

function bindLegacyPasswordVisibility(form: HTMLFormElement | null) {
  const toggle = form?.querySelector<HTMLButtonElement>('[data-action="toggle-password-visibility"]');
  toggle?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const passwordInput = form?.querySelector<HTMLInputElement>('input[name="password"]');
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
  toggle?.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
}

function sanitizeLegacyLoginEmailInput(emailInput: HTMLInputElement | null) {
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
}

function clampLegacyLoginPasswordInput(passwordInput: HTMLInputElement | null) {
  if (!passwordInput) {
    return;
  }
  const nextValue = clampLoginPasswordValue(passwordInput.value);
  if (nextValue !== passwordInput.value) {
    const caret = Math.min(passwordInput.selectionStart ?? nextValue.length, nextValue.length);
    passwordInput.value = nextValue;
    passwordInput.setSelectionRange(caret, caret);
  }
}

function syncLegacyLoginCapsLock(capsLockHint: HTMLElement | null, event: KeyboardEvent) {
  if (!capsLockHint) {
    return;
  }
  capsLockHint.textContent = event.getModifierState('CapsLock') ? 'Caps Lock is on' : '';
}

function isLegacyLoginSubmitKey(event: KeyboardEvent) {
  return event.key === 'Enter'
    || event.key === 'Return'
    || event.code === 'Enter'
    || event.code === 'NumpadEnter'
    || event.keyCode === 13;
}

function bindLegacyLoginInputs(
  section: HTMLElement,
  form: HTMLFormElement | null,
  state: AppState,
  controller: AppController,
  submitLoginForm: () => void,
) {
  const passwordInput = form?.querySelector<HTMLInputElement>('input[name="password"]') ?? null;
  const emailInput = form?.querySelector<HTMLInputElement>('input[name="email"]') ?? null;
  const capsLockHint = section.querySelector<HTMLElement>('#login-capslock');
  const clearErrorOnEdit = () => {
    if (shouldClearAuthFeedbackOnEdit(state.ui.error, state.ui.notice)) {
      controller.clearNotice();
    }
  };

  passwordInput?.addEventListener('keydown', (event) => {
    syncLegacyLoginCapsLock(capsLockHint, event);
  });
  passwordInput?.addEventListener('keyup', (event) => {
    syncLegacyLoginCapsLock(capsLockHint, event);
  });
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

  form?.addEventListener('keydown', (event) => {
    if (!isLegacyLoginSubmitKey(event) || event.shiftKey || event.isComposing || controller.state.ui.busy) {
      return;
    }
    event.preventDefault();
    submitLoginForm();
  });

  emailInput?.addEventListener('input', clearErrorOnEdit);
  passwordInput?.addEventListener('input', clearErrorOnEdit);
  passwordInput?.addEventListener('input', () => {
    clampLegacyLoginPasswordInput(passwordInput);
  });
  emailInput?.addEventListener('paste', () => {
    window.requestAnimationFrame(() => {
      sanitizeLegacyLoginEmailInput(emailInput);
    });
  });
  emailInput?.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault();
    }
  });
  emailInput?.addEventListener('blur', () => {
    sanitizeLegacyLoginEmailInput(emailInput);
  });
  emailInput?.addEventListener('input', () => {
    sanitizeLegacyLoginEmailInput(emailInput);
  });
}

function bindLegacyLoginActions(section: HTMLElement, state: AppState, controller: AppController) {
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
  section.querySelector<HTMLButtonElement>('[data-action="open-frontpage"]')?.addEventListener('click', () => {
    controller.goToPublicLanding();
  });
  section.querySelectorAll<HTMLButtonElement>('[data-action="start-social-login"]').forEach((button) => {
    button.addEventListener('click', () => {
      const provider = String(button.dataset.provider || '').trim().toLowerCase();
      if (provider === 'google' || provider === 'discord') {
        controller.startSocialLogin(provider);
      }
    });
  });
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
  const pathname = typeof window !== 'undefined' ? window.location.pathname || '/' : '/';
  const showFrontpageLink = pathname === '/login';
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
          ${showFrontpageLink ? `
            <button type="button" class="legacy-login-inline-action" data-action="open-frontpage">Back To Frontpage</button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderLoginForm(state: AppState, options: { hasCredentialError: boolean; hasValidationError: boolean; hasAuthError: boolean }) {
  const { hasCredentialError, hasValidationError, hasAuthError } = options;
  const emailFieldClass = getLegacyLoginFieldClass(state.ui.error, hasCredentialError, hasValidationError, 'email');
  const passwordFieldClass = getLegacyLoginFieldClass(state.ui.error, hasCredentialError, hasValidationError, 'password');
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
      <div class="legacy-login-social-block">
        <div class="legacy-login-social-copy">Linked accounts only</div>
        <div class="legacy-login-social-actions">
          <button type="button" class="legacy-btn legacy-login-social-btn" data-action="start-social-login" data-provider="google" ${state.ui.busy ? 'disabled' : ''}>CONTINUE WITH GOOGLE</button>
          <button type="button" class="legacy-btn legacy-login-social-btn" data-action="start-social-login" data-provider="discord" ${state.ui.busy ? 'disabled' : ''}>CONTINUE WITH DISCORD</button>
        </div>
      </div>
      <button type="submit" class="legacy-btn legacy-btn-primary legacy-login-submit ${state.ui.busy ? 'is-busy' : ''}" ${state.ui.busy ? 'disabled' : ''}>
        <span class="legacy-login-submit-copy">${submitLabel}</span>
      </button>
    </form>
  `;
}

function getLegacyLoginFieldClass(
  error: string | null,
  hasCredentialError: boolean,
  hasValidationError: boolean,
  field: 'email' | 'password',
) {
  const hasFieldError = field === 'email'
    ? hasCredentialError || error === 'Email is required.' || error === 'Enter a valid email address.'
    : hasCredentialError || error === 'Password is required.';

  if (!hasFieldError) {
    return '';
  }

  return `field-error ${hasValidationError && !hasCredentialError ? 'field-error-soft' : ''}`.trim();
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
  return renderScopedFlash(state, {
    isError: isRegisterFlashErrorMessage,
    isNotice: (message) => REGISTER_TRANSIENT_NOTICES.has(message),
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
  return renderScopedFlash(state, {
    isError: isPasswordResetFlashErrorMessage,
    isNotice: isPasswordResetFlashNoticeMessage,
  });
}

function renderLoginOtpFlash(state: AppState) {
  return renderScopedFlash(state, {
    isError: isLoginOtpFlashErrorMessage,
    isNotice: isLoginOtpFlashNoticeMessage,
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

  const isLoginOnlyMessage = isDashboardLoginOnlyMessage(message);
  const isRegisterOnlyMessage = isDashboardRegisterOnlyMessage(message);
  const isChangePasswordOnlyMessage = isDashboardChangePasswordOnlyMessage(message);

  if (isLoginOnlyMessage || isRegisterOnlyMessage || isChangePasswordOnlyMessage) {
    return '';
  }

  return renderFlash(state);
}

function isRegisterModalFieldError(error: string | null, field: 'username' | 'email' | 'password' | 'invite') {
  if (field === 'username') {
    return error === 'Username is required.'
      || error === 'Username must be at least 3 characters.'
      || error === 'Username must be 3-32 characters and use only letters, numbers, or underscores.'
      || error === 'Username already taken';
  }

  if (field === 'email') {
    return error === 'Email is required.'
      || error === 'Enter a valid email address.'
      || error === 'Email already registered'
      || error === 'Invalid email format';
  }

  if (field === 'password') {
    return error === 'Password is required.'
      || error === 'Password must be at least 8 characters.'
      || error === 'Password must be 8-128 characters.'
      || error === 'Please confirm your password.'
      || error === 'The passwords do not match. Please check them and try again.';
  }

  return Boolean(
    error === 'Invite code is required.'
    || error?.includes('Invite')
    || error?.includes('invite')
  );
}

function renderRegisterPasswordField(options: {
  label: string;
  name: string;
  toggleAction: string;
  passwordError: boolean;
  busy: boolean;
}) {
  return `
    <label>
      <span>${options.label}</span>
      <div class="legacy-password-wrap">
        <input name="${options.name}" type="password" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" class="${options.passwordError ? 'field-error' : ''}" ${options.busy ? 'disabled' : ''} required />
        <button type="button" class="legacy-password-toggle" data-action="${options.toggleAction}" ${options.busy ? 'disabled' : ''}>Show</button>
      </div>
    </label>
  `;
}

function renderRegisterModal(state: AppState) {
  const usernameError = isRegisterModalFieldError(state.ui.error, 'username');
  const emailError = isRegisterModalFieldError(state.ui.error, 'email');
  const passwordError = isRegisterModalFieldError(state.ui.error, 'password');
  const inviteError = isRegisterModalFieldError(state.ui.error, 'invite');

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
          ${renderRegisterPasswordField({ label: 'Password', name: 'registerPassword', toggleAction: 'toggle-register-password-visibility', passwordError, busy: state.ui.busy })}
          ${renderRegisterPasswordField({ label: 'Confirm password', name: 'registerConfirmPassword', toggleAction: 'toggle-register-confirm-password-visibility', passwordError, busy: state.ui.busy })}
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

function renderEmailVerificationStatusCards(options: {
  emailSendFailed: boolean;
  hasLocalDevLink: boolean;
}) {
  return `
    <div class="legacy-assistance-grid">
      <div class="legacy-assistance-card">
        <div class="legacy-assistance-card-title">${options.emailSendFailed ? 'DELIVERY ISSUE' : 'VERIFICATION SENT'}</div>
        <div class="legacy-assistance-card-copy">${options.emailSendFailed
          ? 'We could not send a confirmation email to '
          : 'We sent a confirmation email to '
        }<strong data-auth-text="pending-verification-email"></strong>${options.emailSendFailed ? ' just yet.' : '.'}</div>
      </div>
      <div class="legacy-assistance-card">
        <div class="legacy-assistance-card-title">AFTER VERIFY</div>
        <div class="legacy-assistance-card-copy">${options.hasLocalDevLink
          ? 'Use the local dev verification link shown above. After confirmation, TrendScope will open the access setup flow with the plans and account-bound checkout.'
          : options.emailSendFailed
            ? 'Try sending the verification link again after fixing email delivery.'
            : 'Open the email and confirm your address. After that, TrendScope will take you into the access setup flow instead of dropping you directly into the bot.'
        }</div>
      </div>
    </div>
  `;
}

function renderEmailVerificationRequestForm(state: AppState, emailError: boolean) {
  return `
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
            <span>${isPostRegisterNotice ? 'We sent a verification link to your registered email. Verify the account before entering the access setup flow.' : 'Request a fresh verification link for your account email.'}</span>
          </div>
          <button type="button" class="legacy-userbar-link" data-action="close-email-verification-panel">Close</button>
        </div>
        <div class="legacy-auth-panel-feedback" data-auth-slot="feedback">${renderPasswordResetFlash(state)}</div>
        ${isPostRegisterNotice ? `
          ${renderEmailVerificationStatusCards({ emailSendFailed, hasLocalDevLink })}
        ` : `
          ${renderEmailVerificationRequestForm(state, emailError)}
        `}
      </div>
    </div>
  `;
}

function isPasswordResetModalFieldError(error: string | null, field: 'email' | 'password') {
  if (field === 'email') {
    return error === 'Email is required.'
      || error === 'Enter a valid email address.';
  }

  return Boolean(
    error === 'New password is required.'
    || error === 'New password must be at least 8 characters.'
    || error === 'New password must be 8-128 characters.'
    || error === 'Please confirm the new password.'
    || error === 'The new passwords do not match. Please check them and try again.'
    || error === 'Reset link is missing or invalid.'
    || error?.includes('Reset token')
  );
}

function renderPasswordResetInfoCards(hasResetToken: boolean) {
  return `
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
  `;
}

function renderPasswordResetPasswordField(options: {
  label: string;
  name: string;
  toggleAction: string;
  passwordError: boolean;
  busy: boolean;
}) {
  return `
    <label>
      <span>${options.label}</span>
      <div class="legacy-password-wrap">
        <input name="${options.name}" type="password" autocomplete="new-password" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" class="${options.passwordError ? 'field-error' : ''}" ${options.busy ? 'disabled' : ''} required />
        <button type="button" class="legacy-password-toggle" data-action="${options.toggleAction}" ${options.busy ? 'disabled' : ''}>Show</button>
      </div>
    </label>
  `;
}

function renderPasswordResetForm(state: AppState, options: { hasResetToken: boolean; emailError: boolean; passwordError: boolean }) {
  const submitLabel = options.hasResetToken
    ? (state.ui.busy ? 'RESETTING...' : 'RESET PASSWORD')
    : (state.ui.busy ? 'SENDING...' : 'SEND RESET LINK');

  return `
    <form class="legacy-auth-panel-form legacy-auth-panel-form-register" data-role="password-reset-form" novalidate>
      ${options.hasResetToken ? `
        ${renderPasswordResetPasswordField({
          label: 'New password',
          name: 'resetNewPassword',
          toggleAction: 'toggle-reset-password-visibility',
          passwordError: options.passwordError,
          busy: state.ui.busy,
        })}
        ${renderPasswordResetPasswordField({
          label: 'Confirm new password',
          name: 'resetConfirmNewPassword',
          toggleAction: 'toggle-reset-confirm-password-visibility',
          passwordError: options.passwordError,
          busy: state.ui.busy,
        })}
      ` : `
        <label>
          <span>Account email</span>
          <input name="resetEmail" type="email" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="${LOGIN_EMAIL_MAX_LENGTH}" class="${options.emailError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
        </label>
      `}
      <div class="legacy-auth-panel-actions">
        <button type="submit" class="legacy-btn legacy-btn-primary" ${state.ui.busy ? 'disabled' : ''}>${submitLabel}</button>
      </div>
    </form>
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
            <div class="legacy-assistance-card-copy">Sign in again from the login page using your new password to continue.</div>
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
            <div class="legacy-assistance-card-copy">Your email is verified. Continue from the login page or, if access setup is still required, follow the access flow that opens next.</div>
          </div>
        </div>
        <div class="legacy-auth-panel-actions">
          <button type="button" class="legacy-btn legacy-btn-primary" data-action="close-email-verified-success">BACK TO LOGIN</button>
        </div>
      </div>
    </div>
  `;
}

function renderInviteAssistanceModal(state: AppState) {
  const showAccountSecurityLink = state.session.status === 'pre_access' || state.session.status === 'authenticated';
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
          ${showAccountSecurityLink ? `
            <div class="legacy-assistance-card">
              <div class="legacy-assistance-card-title">Linked login methods?</div>
              <div class="legacy-assistance-card-copy">Open Account Settings to inspect the Google and Discord identities attached to this account without entering the bot workspace.</div>
            </div>
          ` : ''}
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
            ${showAccountSecurityLink ? `<button type="button" class="legacy-btn legacy-btn-primary" data-action="open-account-security-from-help">OPEN ACCOUNT SETTINGS</button>` : ''}
            <button type="button" class="legacy-userbar-link" data-action="close-invite-assistance-panel">Close</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderPasswordResetModal(state: AppState) {
  const hasResetToken = Boolean(state.ui.pendingPasswordResetToken);
  const emailError = isPasswordResetModalFieldError(state.ui.error, 'email');
  const passwordError = isPasswordResetModalFieldError(state.ui.error, 'password');
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
        ${renderPasswordResetInfoCards(hasResetToken)}
        ${renderPasswordResetForm(state, { hasResetToken, emailError, passwordError })}
        <div class="legacy-auth-panel-note legacy-auth-panel-note-secondary">
          ${INVITE_SECURITY_WARNING}
        </div>
      </div>
    </div>
  `;
}

function getPublicBillingPlanDescriptor(plan: AppState['billing']['plans'][number]) {
  return plan.description || (plan.accessDays >= 30 ? 'Monthly access' : 'Weekly access');
}

function renderPublicBillingPlanValueLine(
  plan: AppState['billing']['plans'][number],
  recommended: boolean,
  shortestPlan: AppState['billing']['plans'][number] | null,
) {
  const dailyRate = formatBillingDailyRate(plan.amountMinor, plan.accessDays);
  const shortestDailyRate = shortestPlan ? formatBillingDailyRate(shortestPlan.amountMinor, shortestPlan.accessDays) : null;
  if (!recommended || !dailyRate || !shortestDailyRate || !shortestPlan || shortestPlan.key === plan.key) {
    return '';
  }

  return `<div class="legacy-public-plan-value-line">~${escapeHtml(dailyRate)} vs ${escapeHtml(shortestDailyRate)} on ${escapeHtml(shortestPlan.label.toLowerCase())}</div>`;
}

function renderPublicBillingPlanButton(
  state: AppState,
  plan: AppState['billing']['plans'][number],
  recommended: boolean,
  pending: boolean,
) {
  return `
    <button
      type="button"
      class="legacy-btn ${recommended ? 'legacy-btn-primary' : 'legacy-public-plan-ghost-btn'}"
      data-action="start-pre-access-checkout"
      data-plan-key="${escapeHtml(plan.key)}"
      ${!plan.available || pending || state.session.accessHasProductAccess ? 'disabled' : ''}
    >${state.billing.providerMocked ? 'OPEN LOCAL CHECKOUT' : 'CONTINUE TO CHECKOUT'}</button>
  `;
}

function renderProfileBillingPlanButton(
  state: AppState,
  plan: AppState['billing']['plans'][number],
  pending: boolean,
) {
  return `
    <button
      type="button"
      class="legacy-btn legacy-profile-billing-btn"
      data-action="start-billing-checkout"
      data-plan-key="${escapeHtml(plan.key)}"
      ${!plan.available || pending ? 'disabled' : ''}
    >${state.billing.providerMocked ? 'OPEN LOCAL CHECKOUT' : 'CONTINUE TO CHECKOUT'}</button>
  `;
}

function renderPublicBillingPlanCard(
  state: AppState,
  plan: AppState['billing']['plans'][number],
  recommendedPlanKey: string | null,
  shortestPlan: AppState['billing']['plans'][number] | null,
) {
  const pending = state.billing.pendingPlanKey === plan.key;
  const recommended = recommendedPlanKey === plan.key;
  const descriptor = getPublicBillingPlanDescriptor(plan);

  return `
    <div class="legacy-billing-plan-card legacy-pre-access-plan-card legacy-public-pricing-card ${recommended ? 'featured recommended' : ''} ${pending ? 'pending' : ''}">
      ${recommended ? `<span class="legacy-public-plan-floating-badge">Best value</span>` : ''}
      <div class="legacy-pre-access-plan-topline legacy-public-plan-topline">
        <span class="legacy-pre-access-plan-badge">Access plan</span>
        <span class="legacy-pre-access-plan-duration">${plan.accessDays} day${plan.accessDays === 1 ? '' : 's'}</span>
      </div>
      <div class="legacy-billing-plan-copy legacy-public-plan-copy">
        <strong>${escapeHtml(plan.label)}</strong>
        <span>${escapeHtml(descriptor)}</span>
      </div>
      <div class="legacy-public-plan-price-row">
        <span>${escapeHtml(String(plan.currencyCode || '').trim().toUpperCase())}</span>
        <strong class="legacy-billing-plan-price legacy-public-plan-price">${escapeHtml(formatBillingMajorAmount(plan.amountMinor))}</strong>
      </div>
      <div class="legacy-billing-plan-meta legacy-public-plan-meta">${plan.available ? 'Continue with account-bound checkout in a new tab' : escapeHtml(plan.availabilityReason || 'Unavailable')}</div>
      ${renderPublicBillingPlanValueLine(plan, recommended, shortestPlan)}
      ${pending ? `<div class="legacy-billing-plan-pending-banner"><span class="legacy-billing-plan-spinner" aria-hidden="true"></span>Generating secure checkout link...</div>` : ''}
      <div class="legacy-auth-panel-actions legacy-user-settings-actions">
        ${renderPublicBillingPlanButton(state, plan, recommended, pending)}
      </div>
    </div>
  `;
}

function renderProfileBillingPlanCard(
  state: AppState,
  plan: AppState['billing']['plans'][number],
) {
  const pending = state.billing.pendingPlanKey === plan.key;
  const descriptor = getPublicBillingPlanDescriptor(plan);

  return `
    <div class="legacy-billing-plan-card legacy-profile-billing-card ${plan.featured ? 'featured' : ''} ${pending ? 'pending' : ''}">
      <div class="legacy-pre-access-plan-topline legacy-profile-billing-topline">
        <span class="legacy-pre-access-plan-badge legacy-profile-billing-badge">Access plan</span>
        <span class="legacy-pre-access-plan-duration legacy-profile-billing-duration">${plan.accessDays} day${plan.accessDays === 1 ? '' : 's'}</span>
      </div>
      <div class="legacy-billing-plan-copy legacy-profile-billing-copy">
        <strong>${escapeHtml(plan.label)}</strong>
        <span>${escapeHtml(descriptor)}</span>
      </div>
      <div class="legacy-profile-billing-price-row">
        <span>${escapeHtml(String(plan.currencyCode || '').trim().toUpperCase())}</span>
        <strong class="legacy-billing-plan-price legacy-profile-billing-price">${escapeHtml(formatBillingMajorAmount(plan.amountMinor))}</strong>
      </div>
      <div class="legacy-billing-plan-meta legacy-profile-billing-meta">${plan.available ? 'Continue with account-bound checkout in a new tab' : escapeHtml(plan.availabilityReason || 'Unavailable')}</div>
      ${pending ? `<div class="legacy-billing-plan-pending-banner"><span class="legacy-billing-plan-spinner" aria-hidden="true"></span>Generating secure checkout link...</div>` : ''}
      <div class="legacy-auth-panel-actions legacy-user-settings-actions">
        ${renderProfileBillingPlanButton(state, plan, pending)}
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

function formatBillingMajorAmount(amountMinor: number) {
  const amount = Number(amountMinor);
  if (!Number.isFinite(amount)) {
    return '-';
  }
  return (amount / 100).toFixed(2);
}

function formatBillingDailyRate(amountMinor: number, accessDays: number) {
  const amount = Number(amountMinor);
  const days = Number(accessDays);
  if (!Number.isFinite(amount) || !Number.isFinite(days) || days <= 0) {
    return null;
  }
  return `$${(amount / 100 / days).toFixed(2)}/day`;
}

function getBillingReceiptUrl(orderId: number) {
  return `/api/account-security/billing/orders/${encodeURIComponent(String(orderId))}/receipt`;
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

function renderIdentityProviderMark(provider: 'google' | 'discord') {
  if (provider === 'discord') {
    return `
      <svg viewBox="0 0 127.14 96.36" aria-hidden="true" focusable="false">
        <path
          fill="#eef4ff"
          d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.27 8.14C2.75 33.35-1.71 57.94.52 82.18a105.73 105.73 0 0 0 32.17 16.18 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.84-5.18c.91-.66 1.79-1.34 2.64-2.04a75.55 75.55 0 0 0 64.32 0c.85.7 1.73 1.38 2.64 2.04a68.68 68.68 0 0 1-10.86 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.18c2.61-28.06-4.41-52.42-18.87-74.11ZM42.45 65.69C36.16 65.69 31 59.93 31 52.82s5.1-12.87 11.45-12.87c6.4 0 11.56 5.81 11.45 12.87 0 7.11-5.1 12.87-11.45 12.87Zm42.24 0c-6.29 0-11.45-5.76-11.45-12.87s5.1-12.87 11.45-12.87c6.4 0 11.56 5.81 11.45 12.87 0 7.11-5.05 12.87-11.45 12.87Z"
        />
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M21.6 12.23c0-.76-.07-1.49-.19-2.2H12v4.17h5.39a4.61 4.61 0 0 1-2 3.03v2.52h3.24c1.89-1.74 2.97-4.29 2.97-7.52Z"/>
      <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.45l-3.24-2.52c-.9.6-2.05.95-3.37.95-2.59 0-4.79-1.75-5.57-4.1H3.08v2.6A10 10 0 0 0 12 22Z"/>
      <path fill="#FBBC05" d="M6.43 13.88A5.99 5.99 0 0 1 6.12 12c0-.65.11-1.28.31-1.88V7.52H3.08A10 10 0 0 0 2 12c0 1.61.38 3.14 1.08 4.48l3.35-2.6Z"/>
      <path fill="#EA4335" d="M12 6.02c1.47 0 2.79.5 3.83 1.49l2.87-2.87C16.95 2.96 14.7 2 12 2a10 10 0 0 0-8.92 5.52l3.35 2.6c.78-2.35 2.98-4.1 5.57-4.1Z"/>
    </svg>
  `;
}

function renderAccountAccessSummaryCard(state: AppState) {
  const statusLabel = getAccessStatusLabel(state);
  const expiryLabel = formatAccessDate(state.session.accessExpiresAt);
  const sourceLabel = state.session.accessSource ? state.session.accessSource.toUpperCase() : '-';
  const remainingLabel = state.session.accessDaysRemaining == null
    ? 'Unlimited'
    : `${state.session.accessDaysRemaining} day${state.session.accessDaysRemaining === 1 ? '' : 's'}`;
  const username = escapeHtml(state.session.username ?? '-');
  const email = escapeHtml(state.session.email ?? '-');
  const role = escapeHtml(formatUserRole(state.session.role));
  const emailStatus = escapeHtml(formatEmailVerificationStatus(state));
  const initialsSource = (state.session.username ?? state.session.email ?? 'U').trim();
  const avatarText = escapeHtml((initialsSource.slice(0, 2) || 'U').toUpperCase());

  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide legacy-user-identity-access-card">
      <div class="legacy-account-access-topline">
        <div class="legacy-account-access-main">
          <div class="legacy-account-access-avatar">${avatarText}</div>
          <div class="legacy-account-access-copy">
            <div class="legacy-account-access-primary">
              <strong>${username}</strong>
              <span>${email}</span>
            </div>
            <div class="legacy-account-access-meta">
              <span>${role}</span>
              <span>${emailStatus}</span>
            </div>
          </div>
        </div>
        <div class="legacy-account-access-status">
          <span class="legacy-account-access-status-badge">${escapeHtml(statusLabel)}</span>
          <strong>${escapeHtml(remainingLabel)}</strong>
        </div>
      </div>
      <div class="legacy-account-access-divider"></div>
      <div class="legacy-account-access-grid">
        <div class="legacy-account-access-item">
          <span>Expires</span>
          <strong>${escapeHtml(expiryLabel)}</strong>
        </div>
        <div class="legacy-account-access-item legacy-account-access-item-inline">
          <span>Access Source</span>
          <div class="legacy-account-access-inline">
            <strong>${escapeHtml(sourceLabel)}</strong>
            <button type="button" class="legacy-btn legacy-btn-soft-accent legacy-account-access-billing-btn" data-action="focus-billing-plans">OPEN BILLING</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderUserLinkedIdentitiesCard(
  state: AppState,
  options?: { allowConnectActions?: boolean; allowUnlinkActions?: boolean },
) {
  const allowConnectActions = options?.allowConnectActions !== false;
  const allowUnlinkActions = options?.allowUnlinkActions === true;
  const loadingMessage = !state.identities.loaded && !state.identities.error
    ? 'Loading linked identity status...'
    : null;

  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide">
      <div class="legacy-user-settings-card-head">
        <strong>Connected Identities</strong>
        <span>Providers already attached to this account and available for linked-only sign-in.</span>
      </div>
      ${state.identities.error ? `
        <div class="legacy-auth-panel-note" data-state="error">${escapeHtml(state.identities.error)}</div>
      ` : ''}
      ${loadingMessage ? `
        <div class="legacy-auth-panel-note">${escapeHtml(loadingMessage)}</div>
      ` : `
        <div class="legacy-linked-identity-list">
          ${state.identities.providers.map((provider) => `
            <div class="legacy-linked-identity-row">
              <div class="legacy-linked-identity-provider-mark">${renderIdentityProviderMark(provider.provider)}</div>
              <div class="legacy-linked-identity-main">
                <strong>${escapeHtml(provider.label)}</strong>
                <span>${escapeHtml(provider.providerDisplayName || provider.providerEmail || (provider.configured ? 'Ready for linking' : 'Provider unavailable'))}</span>
                <span class="legacy-linked-identity-meta">${escapeHtml(
                  provider.linked
                    ? `Linked ${formatDateTime(provider.linkedAt)}`
                    : provider.configured
                      ? 'Not linked yet'
                      : 'Missing OAuth config'
                )}</span>
              </div>
              <div class="legacy-linked-identity-side">
                ${provider.linked || !allowConnectActions ? '' : `
                  <button
                    type="button"
                    class="legacy-btn legacy-btn-soft-accent legacy-linked-identity-connect"
                    data-action="start-social-link"
                    data-provider="${escapeHtml(provider.provider)}"
                    ${provider.configured ? '' : 'disabled'}
                  >CONNECT ${escapeHtml(provider.label.toUpperCase())}</button>
                `}
                ${!provider.linked || !allowUnlinkActions ? '' : `
                  ${state.ui.pendingIdentityUnlinkProvider === provider.provider ? `
                    <form class="legacy-auth-panel-form" data-role="unlink-social-identity-form" data-provider="${escapeHtml(provider.provider)}" novalidate>
                      <label>
                        <span>Current password</span>
                        <input name="currentPassword" type="password" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" ${state.ui.busy ? 'disabled' : ''} required />
                      </label>
                      <div class="legacy-auth-panel-actions legacy-user-settings-actions">
                        <button type="button" class="legacy-userbar-link" data-action="cancel-social-unlink" ${state.ui.busy ? 'disabled' : ''}>Cancel</button>
                        <button type="submit" class="legacy-btn legacy-btn-outline-accent" ${state.ui.busy ? 'disabled' : ''}>${state.ui.busy ? 'UNLINKING...' : `UNLINK ${escapeHtml(provider.label.toUpperCase())}`}</button>
                      </div>
                    </form>
                  ` : `
                    <button
                      type="button"
                      class="legacy-btn legacy-btn-outline-accent legacy-linked-identity-unlink"
                      data-action="open-social-unlink"
                      data-provider="${escapeHtml(provider.provider)}"
                      ${state.ui.busy ? 'disabled' : ''}
                    >UNLINK ${escapeHtml(provider.label.toUpperCase())}</button>
                  `}
                `}
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

function renderUserSecurityCard(state: AppState) {
  const otpStatus = state.session.isEmailVerified
    ? 'Login still requires the email verification code step.'
    : 'Verify the account email before using recovery and login features normally.';
  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide legacy-security-inline-card">
      <div class="legacy-security-inline-copy">
        <strong>Security</strong>
        <span>${escapeHtml(otpStatus)}</span>
      </div>
      <div class="legacy-auth-panel-actions legacy-user-settings-actions">
        <button type="button" class="legacy-btn legacy-btn-outline-accent" data-action="open-change-password-from-user-settings" ${state.ui.busy ? 'disabled' : ''}>CHANGE PASSWORD</button>
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
        <div class="legacy-billing-plan-grid legacy-profile-billing-grid">
          ${state.billing.plans.map((plan) => renderProfileBillingPlanCard(state, plan)).join('')}
        </div>
      `}
    </div>
  `;
}

function renderPreAccessPlansCard(state: AppState) {
  const billingUnavailableMessage = !state.billing.loaded
    ? 'Loading access plans...'
    : !state.billing.enabled
      ? 'Billing is disabled in this environment.'
      : !state.billing.providerReady
        ? 'MoonPay Commerce credentials are not configured yet.'
        : state.billing.plans.length === 0
          ? 'No billing plans are configured yet.'
          : null;
  const recommendedPlanKey = state.billing.plans
    .slice()
    .sort((left, right) => (right.accessDays || 0) - (left.accessDays || 0))[0]?.key ?? null;
  const shortestPlan = state.billing.plans
    .slice()
    .sort((left, right) => (left.accessDays || 0) - (right.accessDays || 0))[0] ?? null;

  return `
    ${state.billing.providerMocked ? `
      <div class="legacy-auth-panel-note">Local billing mock mode is active. Checkout and payment confirmation are simulated on this machine.</div>
    ` : ''}
    ${state.billing.error ? `
      <div class="legacy-auth-panel-note" data-state="error">${escapeHtml(state.billing.error)}</div>
    ` : ''}
    ${billingUnavailableMessage ? `
      <div class="legacy-auth-panel-note">${escapeHtml(billingUnavailableMessage)}</div>
    ` : `
      <div class="legacy-billing-plan-grid legacy-public-pricing-grid" data-role="billing-plans-card">
        ${state.billing.plans.map((plan) => renderPublicBillingPlanCard(state, plan, recommendedPlanKey, shortestPlan)).join('')}
      </div>
    `}
    <div class="legacy-public-pricing-trust-line">Payment via USDC on Solana · Access activates after payment confirmation · No recurring charges</div>
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
                <span>${escapeHtml(formatBillingAmount(order.currencyCode, order.currencyAmountMinor))}</span>
              </div>
              <div class="legacy-billing-order-side">
                <span>${escapeHtml(getBillingOrderStatusLabel(order.status))}</span>
                <span>${escapeHtml(order.paidAt ? formatDateTime(order.paidAt) : formatDateTime(order.createdAt))}</span>
                ${order.status === 'paid' ? `
                  <a
                    class="legacy-userbar-link"
                    href="${escapeHtml(getBillingReceiptUrl(order.id))}"
                    target="_blank"
                    rel="noopener"
                  >Receipt</a>
                ` : ''}
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

function renderUserSettingsModal(state: AppState) {
  return renderProfileModalShell({
    panel: 'user-settings',
    title: 'User Settings',
    description: 'Review account access, identity state, and security actions without mixing them into bot config.',
    labelId: 'user-settings-title',
    panelClass: 'legacy-auth-panel-user-settings',
    content: `
      <div class="legacy-user-settings-grid">
        ${renderAccountAccessSummaryCard(state)}
        ${renderUserSecurityCard(state)}
        ${renderUserLinkedIdentitiesCard(state, { allowUnlinkActions: true })}
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
    <div class="config-item config-item-sound">
      <label>Card effects</label>
      <select name="card-effects-mode">
        <option value="on">Enabled</option>
        <option value="off">Disabled</option>
      </select>
    </div>
    ${renderTradeTerminalPrefsMenu(state)}
    ${renderSurgeThresholdMenu(state)}
    ${renderConfigToggleMenu(state, 'Alert toggles', 'Choose which alert types can fire', ALERT_TOGGLE_FIELDS)}
    ${renderConfigToggleMenu(state, 'Sound by alert type', 'Choose which alert types can play sound', SOUND_TOGGLE_FIELDS)}
    ${renderConfigToggleMenu(
      state,
      'Safety prompts',
      'Choose which confirmation prompts should appear before destructive workspace actions.',
      SAFETY_TOGGLE_FIELDS,
      {
        helpLabel: 'What are safety prompts?',
        helpText: 'Choose which confirmation prompts should appear before destructive workspace actions.',
        hideSummary: true,
      },
    )}
    ${state.session.role === 'admin' ? renderAdminChainField(state) : ''}
    ${state.session.role === 'admin' ? renderAdminNetworkDebugCard(state) : ''}
    <div class="legacy-sound-row">
      <div class="config-item config-item-sound config-item-sound-volume">
        <label>Sound volume: ${Math.round(state.ui.soundVolume * 100)}%</label>
        <input name="sound-volume" class="legacy-volume-slider" type="range" min="0" max="100" step="1" />
      </div>
      ${renderSoundUploadStrip(state)}
    </div>
  `;
}

function renderAdminNetworkDebugCard(state: AppState) {
  const entries = state.ui.networkDebugEntries;

  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide">
      <div class="legacy-user-settings-card-head">
        <strong>Admin Network Debug</strong>
        <span>Temporary local capture of transport-level API fetch failures</span>
      </div>
      <label class="legacy-block-warning-toggle">
        <input
          type="checkbox"
          data-action="toggle-network-debug"
          ${state.ui.networkDebugEnabled ? 'checked' : ''}
        />
        <span>Capture exact network fetch failures in this browser</span>
      </label>
      <div class="config-menu-summary">
        This is local to your current browser profile only. It records the path, method, API base, timestamp, and raw fetch error message whenever a browser-level API request fails before an HTTP response exists.
      </div>
      <div class="legacy-auth-panel-actions legacy-user-settings-actions">
        <button type="button" class="legacy-userbar-link" data-action="clear-network-debug-log" ${entries.length === 0 ? 'disabled' : ''}>Clear log</button>
      </div>
      ${entries.length === 0 ? `
        <div class="blocked-token-empty">No captured network failures yet.</div>
      ` : `
        <div class="blocked-tokens-modal-list">
          ${entries.map((entry) => `
            <div class="blocked-token-row">
              <div class="blocked-token-main">
                <div class="blocked-token-copy">
                  <strong>${escapeHtml(entry.method)} ${escapeHtml(entry.path)}</strong>
                  <span>${escapeHtml(new Date(entry.ts).toLocaleString('en-US'))}</span>
                  <span>${escapeHtml(entry.message)}</span>
                  <span>${escapeHtml(entry.apiBase)}</span>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

function renderTradeTerminalPrefsMenu(state: AppState) {
  const terminalFields: Array<{ key: AppState['ui']['enabledTradeTerminals'][number]; label: string }> = [
    { key: 'axiom', label: 'Axiom' },
    { key: 'photon', label: 'Photon' },
    { key: 'bullx', label: 'BullX' },
    { key: 'gmgn', label: 'GMGN' },
    { key: 'padre', label: 'Padre' },
  ];
  const enabled = new Set(state.ui.enabledTradeTerminals);

  return `
    <div class="config-item config-item-menu">
      <label>Trading terminals</label>
      <div class="sort-menu-wrap config-menu-wrap trade-terminal-menu-wrap" data-sort-wrap>
        <button type="button" class="old-filter-btn config-menu-button active" data-sort-toggle="trade-terminals">${state.ui.enabledTradeTerminals.length}/${terminalFields.length} on</button>
        <div class="sort-menu-dropdown config-menu-dropdown">
          <div class="config-menu-summary">Choose which terminal destinations appear in redirect buttons. If only one stays enabled, the terminal button opens it directly.</div>
          <div class="config-toggle-list">
            ${terminalFields.map((field) => {
              const isActive = enabled.has(field.key);
              return `
                <button
                  type="button"
                  class="config-toggle-item ${isActive ? 'active' : ''}"
                  data-trade-terminal-key="${escapeHtml(field.key)}"
                >
                  <span>${escapeHtml(field.label)}</span>
                  <span class="config-toggle-state">${isActive ? 'ON' : 'OFF'}</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>
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
  bindLinkedIdentityActions(section, controller);
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

function bindLinkedIdentityActions(section: ParentNode, controller: AppController) {
  section.querySelectorAll<HTMLButtonElement>('[data-action="start-social-link"]').forEach((button) => {
    button.addEventListener('click', () => {
      const provider = button.dataset.provider;
      if (provider !== 'google' && provider !== 'discord') {
        return;
      }
      controller.startSocialLink(provider);
    });
  });

  section.querySelectorAll<HTMLButtonElement>('[data-action="open-social-unlink"]').forEach((button) => {
    button.addEventListener('click', () => {
      const provider = button.dataset.provider;
      if (provider !== 'google' && provider !== 'discord') {
        return;
      }
      const providerLabel = provider === 'google' ? 'Google' : 'Discord';
      const confirmed = window.confirm(
        `Removing ${providerLabel} sign-in will disable future social login with that provider until you link it again from this authenticated session. Continue?`,
      );
      if (!confirmed) {
        return;
      }
      controller.openIdentityUnlink(provider);
    });
  });

  section.querySelectorAll<HTMLButtonElement>('[data-action="cancel-social-unlink"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      controller.cancelIdentityUnlink();
    });
  });

  section.querySelectorAll<HTMLFormElement>('form[data-role="unlink-social-identity-form"]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const provider = form.dataset.provider;
      if (provider !== 'google' && provider !== 'discord') {
        return;
      }
      const data = new FormData(form);
      void controller.unlinkSocialIdentity(provider, String(data.get('currentPassword') || ''));
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

  const commitInputIfNeeded = async (input: HTMLInputElement) => {
    if (input.dataset.pendingCommit !== 'true' || input.dataset.submitInFlight === 'true') {
      return;
    }

    input.dataset.submitInFlight = 'true';
    try {
      await submitLegacyConfig(configSection, controller);
      input.dataset.pendingCommit = 'false';
    } finally {
      input.dataset.submitInFlight = 'false';
    }
  };

  const blurConfigFieldIfNeeded = (element: Element | null) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) {
      return;
    }
    if (!configSection.contains(element)) {
      return;
    }
    element.blur();
  };

  configSection.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]').forEach((input) => {
    const name = input.name;
    if (name === 'sound-volume') {
      return;
    }

    if (input instanceof HTMLSelectElement) {
      input.addEventListener('change', (event) => {
        void submitLegacyConfig(configSection, controller);
        (event.currentTarget as HTMLSelectElement).blur();
      });
      return;
    }

    input.addEventListener('input', () => {
      input.dataset.pendingCommit = 'true';
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') {
        return;
      }
      event.preventDefault();
      void commitInputIfNeeded(input);
    });
    input.addEventListener('blur', () => {
      void commitInputIfNeeded(input);
    });
  });

  section.querySelectorAll<HTMLElement>('[data-action="close-profile-modal"]').forEach((element) => {
    element.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const active = document.activeElement;
      blurConfigFieldIfNeeded(active);
      if (
        active instanceof HTMLInputElement
        && configSection.contains(active)
        && active.name
        && active.name !== 'sound-volume'
        && active.dataset.pendingCommit === 'true'
      ) {
        void commitInputIfNeeded(active);
      }

      if (active instanceof HTMLSelectElement && configSection.contains(active)) {
        active.blur();
      }

      controller.closeAuthPanel();
    });
  });

  panel.addEventListener('pointerdown', (event) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) || !configSection.contains(active)) {
      return;
    }

    if (!active.name || active.name === 'sound-volume' || active.dataset.pendingCommit !== 'true') {
      return;
    }

    const target = event.target;
    if (target instanceof Node && active.contains(target)) {
      return;
    }

    active.blur();
    void commitInputIfNeeded(active);
  }, true);

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

  configSection.querySelector<HTMLInputElement>('[data-action="toggle-network-debug"]')?.addEventListener('change', (event) => {
    controller.setNetworkDebugEnabled((event.currentTarget as HTMLInputElement).checked);
  });
  configSection.querySelector<HTMLButtonElement>('[data-action="clear-network-debug-log"]')?.addEventListener('click', () => {
    controller.clearNetworkDebugEntries();
  });

  bindConfigToggleMenus(configSection, controller);
  bindTradeTerminalPrefsMenu(configSection, controller);
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

function bindTradeTerminalPrefsMenu(section: HTMLElement, controller: AppController) {
  const wrap = section.querySelector<HTMLElement>('.trade-terminal-menu-wrap');
  if (!wrap) {
    return;
  }

  const getItems = () => [...wrap.querySelectorAll<HTMLButtonElement>('[data-trade-terminal-key]')];

  const updateSummary = () => {
    const toggleButton = wrap.querySelector<HTMLButtonElement>('.config-menu-button');
    const items = getItems();
    if (!toggleButton || items.length === 0) {
      return;
    }
    const enabledCount = items.filter((item) => item.classList.contains('active')).length;
    toggleButton.textContent = `${enabledCount}/${items.length} on`;
  };

  wrap.querySelectorAll<HTMLButtonElement>('[data-trade-terminal-key]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const items = getItems();
      const activeItems = items.filter((item) => item.classList.contains('active'));
      const isActive = button.classList.contains('active');
      if (isActive && activeItems.length <= 1) {
        return;
      }

      button.classList.toggle('active', !isActive);
      const stateLabel = button.querySelector<HTMLElement>('.config-toggle-state');
      if (stateLabel) {
        stateLabel.textContent = isActive ? 'OFF' : 'ON';
      }

      updateSummary();
      controller.setEnabledTradeTerminals(
        items
          .filter((item) => item.classList.contains('active'))
          .map((item) => item.dataset.tradeTerminalKey)
          .filter((item): item is AppState['ui']['enabledTradeTerminals'][number] => Boolean(item)),
      );
    });
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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.ui.busy) {
      return;
    }

    const data = new FormData(form);
    const inviteCode = String(data.get('inviteCode') || '').trim();
    if (inviteInput) {
      inviteInput.value = inviteCode;
    }
    if (!inviteCode) {
      setInviteStatus('Invite code is required for account creation.', 'error');
      return;
    }

    setInviteStatus('Checking invite code...', 'idle');
    try {
      const inviteValidation = await controller.validateInvite(inviteCode);
      if (!inviteValidation.valid) {
        setInviteStatus(inviteValidation.reason || 'Invite code is not valid.', 'error');
        return;
      }
      setInviteStatus('Invite code looks valid.', 'ok');
    } catch {
      setInviteStatus('Unable to validate invite code right now.', 'error');
      return;
    }

    void controller.register({
      username: String(data.get('username') || ''),
      email: String(data.get('registerEmail') || ''),
      password: String(data.get('registerPassword') || ''),
      confirmPassword: String(data.get('registerConfirmPassword') || ''),
      inviteCode,
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
  section.querySelector<HTMLButtonElement>('[data-action="open-account-security-from-help"]')?.addEventListener('click', () => {
    closePanel();
    controller.goToAccountSecurity();
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

function renderSurgeThresholdMenu(state: AppState) {
  const recent1h = Number(state.data.configs['recent-surge-1h-threshold'] ?? 50);
  const recent6h = Number(state.data.configs['recent-surge-6h-threshold'] ?? 150);
  const oldWeek1h = Number(state.data.configs['old-week-surge-1h-threshold'] ?? 50);
  const oldWeek6h = Number(state.data.configs['old-week-surge-6h-threshold'] ?? 150);
  return `
    <div class="config-item config-item-menu">
      <label>
        <span>Surge threshold</span>
        <span class="config-help-hover" tabindex="0" aria-label="What is Surge alert?">
          <span class="config-help-trigger">?</span>
          <span class="config-help-panel">
            Surge uses token age and Dex price change. Recent surge covers tokens from 2d up to 7d old, and old surge covers tokens from 7d+. Already-hot tokens are suppressed on startup until a real new crossing happens.
          </span>
        </span>
      </label>
      <div class="sort-menu-wrap config-menu-wrap" data-sort-wrap>
        <button type="button" class="old-filter-btn config-menu-button active" data-sort-toggle="surge-threshold">Recent ${Math.round(recent1h)}%/${Math.round(recent6h)}% · Old ${Math.round(oldWeek1h)}%/${Math.round(oldWeek6h)}%</button>
        <div class="sort-menu-dropdown config-menu-dropdown config-threshold-dropdown">
          <div class="config-threshold-grid">
            <div class="config-threshold-field">
              <span>Recent 1H (2d-7d)</span>
              <input type="number" min="0" name="recent-surge-1h-threshold" />
            </div>
            <div class="config-threshold-field">
              <span>Recent 6H (2d-7d)</span>
              <input type="number" min="0" name="recent-surge-6h-threshold" />
            </div>
            <div class="config-threshold-field">
              <span>Old 1H (7d+)</span>
              <input type="number" min="0" name="old-week-surge-1h-threshold" />
            </div>
            <div class="config-threshold-field">
              <span>Old 6H (7d+)</span>
              <input type="number" min="0" name="old-week-surge-6h-threshold" />
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
  options?: { helpLabel?: string; helpText?: string; hideSummary?: boolean },
) {
  const enabledCount = fields.filter((field) => isConfigEnabled(state, field.key)).length;
  const safeLabel = escapeHtml(label);
  const safeSummaryLabel = escapeHtml(summaryLabel);
  const safeToggleKey = escapeHtml(label.toLowerCase().replace(/\s+/g, '-'));
  const safeHelpLabel = escapeHtml(options?.helpLabel || `What is ${label}?`);
  const safeHelpText = options?.helpText ? escapeHtml(options.helpText) : '';
  const shouldUseScrollableList = fields.length > 6;
  const listClass = shouldUseScrollableList
    ? 'config-toggle-list config-toggle-list-scroll'
    : 'config-toggle-list';
  const dropdownClass = shouldUseScrollableList
    ? 'sort-menu-dropdown config-menu-dropdown config-menu-dropdown-scroll'
    : 'sort-menu-dropdown config-menu-dropdown';
  return `
    <div class="config-item config-item-menu">
      <label>
        <span>${safeLabel}</span>
        ${safeHelpText ? `
          <span class="config-help-hover" tabindex="0" aria-label="${safeHelpLabel}">
            <span class="config-help-trigger">?</span>
            <span class="config-help-panel">${safeHelpText}</span>
          </span>
        ` : ''}
      </label>
      <div class="sort-menu-wrap config-menu-wrap" data-sort-wrap>
        <button type="button" class="old-filter-btn config-menu-button active" data-sort-toggle="${safeToggleKey}">${enabledCount}/${fields.length} on</button>
        <div class="${dropdownClass}">
          ${options?.hideSummary ? '' : `<div class="config-menu-summary">${safeSummaryLabel}</div>`}
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
  const recent1hThreshold = Number(state.data.configs['recent-surge-1h-threshold'] ?? 50);
  const recent6hThreshold = Number(state.data.configs['recent-surge-6h-threshold'] ?? 150);
  const oldWeek1hThreshold = Number(state.data.configs['old-week-surge-1h-threshold'] ?? 50);
  const oldWeek6hThreshold = Number(state.data.configs['old-week-surge-6h-threshold'] ?? 150);
  const slots: Array<{ slot: CustomSoundSlot; title: string; sub: string; dot: string }> = [
    { slot: 'normal', title: 'Sound Level Normal', sub: '(+50%) / MP3/WAV/OGG', dot: 'sound-dot normal' },
    { slot: 'critical', title: 'Sound Level Critical', sub: '(+100%) / MP3/WAV/OGG', dot: 'sound-dot critical' },
    { slot: 'mega', title: 'Sound Level Mega', sub: '(+200%) / MP3/WAV/OGG', dot: 'sound-dot mega' },
    {
      slot: 'old1h',
      title: 'Surge + MET Alert 1h',
      sub: `Recent +${Math.round(recent1hThreshold)}% / Old +${Math.round(oldWeek1hThreshold)}% / MP3/WAV/OGG`,
      dot: 'sound-dot old1h',
    },
    {
      slot: 'old6h',
      title: 'Surge Alert 6h',
      sub: `Recent +${Math.round(recent6hThreshold)}% / Old +${Math.round(oldWeek6hThreshold)}% / MP3/WAV/OGG`,
      dot: 'sound-dot old6h',
    },
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

  const cardEffectsMode = section.querySelector<HTMLSelectElement>('select[name="card-effects-mode"]');
  if (cardEffectsMode) {
    cardEffectsMode.value = String(state.data.configs['card-effects-mode'] ?? 'on').trim().toLowerCase() === 'off' ? 'off' : 'on';
  }

  const soundVolume = section.querySelector<HTMLInputElement>('input[name="sound-volume"]');
  if (soundVolume) {
    soundVolume.value = String(Math.round(state.ui.soundVolume * 100));
  }

  const surgeThresholdFields = [
    ['recent-surge-1h-threshold', 50],
    ['recent-surge-6h-threshold', 150],
    ['old-week-surge-1h-threshold', 50],
    ['old-week-surge-6h-threshold', 150],
  ] as const;
  for (const [fieldName, fallback] of surgeThresholdFields) {
    const input = section.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`);
    if (!input) {
      continue;
    }
    input.value = String(Math.round(Number(state.data.configs[fieldName] ?? fallback)));
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
    'min-vol': 8000,
    'min-mcap': 30000,
    'max-mcap': 0,
    'hvnc-min-vol': 300000,
    'old-alert-1h-threshold': 50,
    'old-alert-6h-threshold': 150,
    'recent-surge-1h-threshold': 50,
    'recent-surge-6h-threshold': 150,
    'old-week-surge-1h-threshold': 50,
    'old-week-surge-6h-threshold': 150,
    'meteora-alert-1h-threshold': 50,
    'old-mcap-max': 100000000,
    'old-week-mcap-max': 100000000,
  };
  return String(defaults[key] ?? 0);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
