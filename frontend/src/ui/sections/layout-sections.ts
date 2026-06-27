import type { AppController } from '../../state/app-controller';
import { getExpandedTokenSparkline, getMockTradingPositionView, getMockTradingSummaryView, getTokenSparkline, getTrackedToken, isProfileAuthPanel, type AppState, type LinkedIdentityEntry, type ProfileAuthPanel } from '../../state/app-state';
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
import { bindCopyButtons, bindSparklineHover, fmtMoney, fmtPct, renderFlash, renderSparklineFigure } from './shared';
import { fmtMockSol, fmtMockSolAmount, resolveLiveMockSolUsdcRate, resolveMockTradeSolUsdcRate, resolveMockTradingPositionPnl } from '../../utils/mock-trading-display';

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

type ConfigField = { key: string; label: string; type?: 'number' | 'text'; min?: number; step?: number; placeholder?: string; adminOnly?: boolean };

const CONFIG_FIELDS: ConfigField[] = [
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
  { key: 'alert-high-cap-dump-enabled', label: 'HIGH CAP DUMP 5M' },
  { key: 'alert-gmgn-claim-pump-enabled', label: 'PUMP CLAIM' },
  { key: 'alert-gmgn-claim-bags-enabled', label: 'BAGS CLAIM' },
] as const;

const SOUND_TOGGLE_FIELDS = [
  { key: 'sound-vol-enabled', label: 'VOL' },
  { key: 'sound-mcap-enabled', label: 'MCAP' },
  { key: 'sound-hvnc-enabled', label: 'HIGH VOLUME NEW COIN' },
  { key: 'sound-old-surge-1h-enabled', label: 'SURGE 1H' },
  { key: 'sound-old-surge-6h-enabled', label: 'SURGE 6H' },
  { key: 'sound-meteora-surge-enabled', label: 'METEORA 1H' },
  { key: 'sound-high-cap-dump-enabled', label: 'HIGH CAP DUMP 5M' },
  { key: 'sound-gmgn-claim-signal-enabled', label: 'GMGN CLAIM' },
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
      ${hasTokenEntitlementState(state) ? renderTokenEntitlementStrip(state) : ''}

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
      title: 'Historical Radar View',
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

  if (!hasFreshMonitoring) {
    return { tone: 'unstable', label: 'Unstable' };
  }

  return { tone: 'connected', label: 'Connected' };
}

function renderMockTradingHeaderSummary(state: AppState) {
  const summary = state.session.role === 'admin' ? getMockTradingSummaryView(state) : null;
  if (!summary) {
    return '';
  }

  const pnlTone = summary.totalPnlUsd < 0 ? 'down' : 'up';
  return `
    <div class="workspace-mock-trading-cluster">
      <div class="workspace-mock-trading-summary workspace-mock-trading-cash" data-tone="${pnlTone}">
        <span class="workspace-mock-trading-label">MOCK</span>
        ${renderMockTradingWalletControls(state)}
        ${renderMockSolPriceStatus(state)}
        <strong>Cash ${escapeHtml(fmtMockUsdForState(state, summary.account.cashUsd))}</strong>
        <button type="button" class="workspace-mock-trading-reset workspace-mock-trading-add" data-action="add-mock-trading-cash" ${state.ui.busy ? 'disabled' : ''} title="Add mock SOL">Add</button>
        <button type="button" class="workspace-mock-trading-reset workspace-mock-trading-plays" data-action="open-mock-trading-history" ${state.ui.busy ? 'disabled' : ''} title="Open mock trade history">Plays</button>
        <button type="button" class="workspace-mock-trading-reset" data-action="reset-mock-trading" ${state.ui.busy ? 'disabled' : ''} title="Reset mock portfolio">Reset</button>
      </div>
      ${renderMockTradingHeaderPositions(state)}
    </div>
  `;
}

function getActiveMockTradingWallet(state: AppState) {
  const activeId = state.ui.activeMockTradingWalletId ?? state.data.mockTradingSummary?.wallet?.id ?? null;
  return state.data.mockTradingWallets.find((wallet) => wallet.id === activeId)
    || state.data.mockTradingSummary?.wallet
    || state.data.mockTradingWallets.find((wallet) => wallet.isDefault)
    || state.data.mockTradingWallets[0]
    || null;
}

function getActiveMockTradingWalletName(state: AppState) {
  return getActiveMockTradingWallet(state)?.name || 'Main';
}

function renderMockTradingWalletLabel(wallet: AppState['data']['mockTradingWallets'][number] | null) {
  return `${escapeHtml(wallet?.name || 'Main')}${wallet?.isDefault ? ' *' : ''}`;
}

function renderMockTradingWalletOption(
  wallet: AppState['data']['mockTradingWallets'][number],
  activeId: number | null,
  busy: boolean,
) {
  return `
    <button type="button" class="workspace-mock-wallet-option ${wallet.id === activeId ? 'active' : ''}" data-action="select-mock-trading-wallet" data-wallet-id="${wallet.id}" ${busy ? 'disabled' : ''}>
      <span>${renderMockTradingWalletLabel(wallet)}</span>
    </button>
  `;
}

function renderMockTradingWalletControls(state: AppState) {
  const wallets = state.data.mockTradingWallets;
  const activeWallet = getActiveMockTradingWallet(state);
  if (wallets.length === 0 && !activeWallet) {
    return '';
  }

  const activeId = activeWallet?.id ?? null;
  const defaultDisabled = !activeWallet || activeWallet.isDefault || state.ui.busy;
  const archiveDisabled = !activeWallet || activeWallet.isDefault || wallets.length <= 1 || state.ui.busy;
  return `
    <span class="workspace-mock-wallet">
      <span class="sort-menu-wrap workspace-mock-wallet-select-wrap" data-sort-wrap>
        <button type="button" class="workspace-mock-wallet-select" data-sort-toggle="mock-wallet" ${state.ui.busy ? 'disabled' : ''} aria-label="Mock trading wallet">
          <span>${renderMockTradingWalletLabel(activeWallet)}</span>
          <span class="workspace-mock-wallet-caret">⌄</span>
        </button>
        <span class="sort-menu-dropdown workspace-mock-wallet-menu">
          ${wallets.map((wallet) => renderMockTradingWalletOption(wallet, activeId, state.ui.busy)).join('')}
        </span>
      </span>
      <button type="button" class="workspace-mock-wallet-btn" data-action="create-mock-trading-wallet" ${state.ui.busy ? 'disabled' : ''} title="Create mock wallet" aria-label="Create mock wallet"><span>+</span></button>
      <button type="button" class="workspace-mock-wallet-btn" data-action="rename-mock-trading-wallet" ${!activeWallet || state.ui.busy ? 'disabled' : ''} title="Rename mock wallet" aria-label="Rename mock wallet"><span>✎</span></button>
      <button type="button" class="workspace-mock-wallet-btn" data-action="default-mock-trading-wallet" ${defaultDisabled ? 'disabled' : ''} title="Set as default mock wallet" aria-label="Set as default mock wallet"><span>★</span></button>
      <button type="button" class="workspace-mock-wallet-btn danger" data-action="archive-mock-trading-wallet" ${archiveDisabled ? 'disabled' : ''} title="Archive mock wallet" aria-label="Archive mock wallet"><span>×</span></button>
    </span>
  `;
}

function renderMockTradingHeaderPositions(state: AppState) {
  const positions = Object.values(state.data.mockTradingPositionsByAddress);
  if (positions.length === 0) {
    return '';
  }

  return positions
    .map((position) => renderMockTradingHeaderPosition(state, position.tokenAddress))
    .join('');
}

function renderMockTradingHeaderPosition(state: AppState, address: string) {
  const token = getTrackedToken(state, address);
  const position = getMockTradingPositionView(state, address);
  const symbol = getMockTradingHeaderPositionSymbol(token, position, address);
  const imageUrl = sanitizeOptionalHttpUrl(token?.imageUrl || position?.imageUrl || null);
  const { pnlUsd: pnl, pnlPct: pct } = resolveMockTradingPositionPnl(
    position,
    state.data.mockTradingTradesByAddress[address] || [],
  );
  return `
    <div class="workspace-mock-trading-summary workspace-mock-trading-position" data-tone="${getMockTradingPnlTone(pnl)}" data-action="open-mock-trading-pnl" data-address="${escapeHtml(address)}" role="button" tabindex="0" title="${escapeHtml(buildMockTradingHeaderPositionTitle(state, symbol, pnl, pct, position))}">
      ${renderMockTradingHeaderAvatar(imageUrl, symbol)}
      <strong>${escapeHtml(symbol)}</strong>
      <span>${escapeHtml(fmtMockUsdForState(state, pnl, { signed: true }))}</span>
      <span>${escapeHtml(fmtPct(pct))}</span>
      <button type="button" class="workspace-mock-trading-copy copy-button" data-action="copy-address" data-address="${escapeHtml(address)}" title="Copy contract" aria-label="Copy ${escapeHtml(symbol)} contract">⧉</button>
    </div>
  `;
}

function getMockTradingHeaderPositionSymbol(
  token: ReturnType<typeof getTrackedToken>,
  position: ReturnType<typeof getMockTradingPositionView>,
  address: string,
) {
  return token?.symbol || position?.symbol || address.slice(0, 6);
}

function getMockTradingPnlTone(pnl?: number | null) {
  return pnl != null && pnl < 0 ? 'down' : 'up';
}

function buildMockTradingHeaderPositionTitle(
  state: AppState,
  symbol: string,
  pnl: number | null,
  pct: number | null,
  position: ReturnType<typeof getMockTradingPositionView>,
) {
  const takeProfitTitle = position?.takeProfitOrders?.length
    ? ` · ${formatMockTradingTakeProfitSummary(position.takeProfitOrders)}`
    : '';
  return `${symbol} open mock position · ${fmtMockUsdForState(state, pnl)} ${fmtPct(pct)}${takeProfitTitle}`;
}

function renderMockTradingHeaderAvatar(imageUrl: string | null, symbol: string) {
  return imageUrl
    ? `<img src="${imageUrl}" alt="${escapeHtml(symbol)}" />`
    : `<span class="workspace-mock-trading-position-placeholder">${escapeHtml(symbol.slice(0, 2).toUpperCase())}</span>`;
}

function formatMockTradingTakeProfitSummary(orders: NonNullable<ReturnType<typeof getMockTradingPositionView>>['takeProfitOrders'] = []) {
  const openOrders = Array.isArray(orders) ? orders.filter((order) => order.status === 'open') : [];
  if (openOrders.length === 0) {
    return '';
  }
  const preview = openOrders
    .slice(0, 2)
    .map((order) => `${fmtMoney(order.targetMcapUsd)} / ${fmtPct(order.sellPercent)}`)
    .join(', ');
  const extra = openOrders.length > 2 ? ` +${openOrders.length - 2}` : '';
  return `TP ${preview}${extra}`;
}

function fmtMockUsd(value?: number | null, options: { signed?: boolean; usdcRate?: number } = {}) {
  return fmtMockSol(value, options);
}

function fmtMockUsdForState(state: AppState, value?: number | null, options: { signed?: boolean } = {}) {
  return fmtMockUsd(value, { ...options, usdcRate: resolveLiveMockSolUsdcRate(state.data.mockTradingSummary, state.data.configs) });
}

function renderMockSolPriceStatus(state: AppState) {
  const quote = state.data.mockTradingSummary?.solUsdPrice;
  const price = Number(quote?.priceUsd);
  if (!Number.isFinite(price) || price <= 0) {
    return '<span class="workspace-mock-trading-label">SOL unavailable</span>';
  }

  const label = quote?.stale ? `SOL stale $${price.toFixed(2)}` : `SOL $${price.toFixed(2)}`;
  return `<span class="workspace-mock-trading-label">${escapeHtml(label)}</span>`;
}

export function renderWorkspaceHeader(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-topbar workspace-topbar';
  const isLiveWorkspace = state.ui.workspace === 'live';
  const isHistoryWorkspace = state.ui.workspace === 'history';
  const connectionState = getWorkspaceConnectionState(state);
  const quickBuyMenuItem = renderQuickBuyMenuItem(state);
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
          <a href="${getWorkspaceHref('history')}" class="workspace-route-btn ${isHistoryWorkspace ? 'active' : ''}" data-action="open-workspace-history">RADAR</a>
        </div>
        <div class="workspace-layout-reset" data-role="layout-reset">
          <button type="button" class="workspace-layout-reset-btn" data-action="reset-live-panel-layout" aria-label="Reset bot layout only">
            <span aria-hidden="true">↺</span>
          </button>
          <div class="workspace-layout-reset-tooltip" role="tooltip">
            ${escapeHtml('Reset the bot layout to the default visual setup for a new account. Manual tokens are not changed.')}
          </div>
        </div>
        ${renderMockTradingHeaderSummary(state)}
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
            ${quickBuyMenuItem}
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
  section.querySelector<HTMLButtonElement>('[data-action="reset-mock-trading"]')?.addEventListener('click', () => {
    void controller.resetMockTradingPortfolio();
  });
  section.querySelector<HTMLButtonElement>('[data-action="add-mock-trading-cash"]')?.addEventListener('click', () => {
    void controller.addMockTradingCash();
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-mock-trading-history"]')?.addEventListener('click', () => {
    controller.openMockTradingHistory();
  });
  bindMockTradingWalletHeaderControls(section, controller, state);
  section.querySelectorAll<HTMLElement>('.workspace-mock-trading-position[data-action="open-mock-trading-pnl"]').forEach((badge) => {
    const open = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-action="copy-address"]')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const address = badge.dataset.address;
      if (address) controller.openMockTradingPnlResume(address);
    };
    badge.addEventListener('click', open);
    badge.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      open(event);
    });
  });
  bindCopyButtons(section);
  section.querySelector<HTMLButtonElement>('[data-action="logout"]')?.addEventListener('click', () => void controller.logout());
  section.querySelector<HTMLButtonElement>('[data-action="open-user-settings"]')?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    controller.openAuthPanel('user-settings');
    section.querySelector<HTMLElement>('[data-user-menu]')?.classList.remove('open');
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-floating-quick-buy"]')?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    controller.openFloatingQuickBuy();
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
  section.querySelectorAll<HTMLButtonElement>('.legacy-user-dd-item:not([data-action="open-user-settings"]):not([data-action="open-floating-quick-buy"]):not([data-action="open-bot-settings"]):not([data-action="open-blocked-tokens"]):not([data-action="logout"])').forEach((button) => {
    button.addEventListener('click', () => {
      section.querySelector<HTMLElement>('[data-user-menu]')?.classList.remove('open');
    });
  });

  return section;
}

function renderQuickBuyMenuItem(state: AppState) {
  if (state.session.role !== 'admin') {
    return '';
  }
  return '<button type="button" class="legacy-user-dd-item" data-action="open-floating-quick-buy"><span class="workspace-menu-icon">⚡</span><span>Quick Buy</span></button>';
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
  const overlayMode = resolveWorkspaceOverlayMode(state);
  const expandedSparklineAddress = String(state.ui.expandedSparklineAddress || '').trim();
  const expandedSparkline = expandedSparklineAddress ? getExpandedTokenSparkline(state, expandedSparklineAddress) : null;
  if (overlayMode === 'none') {
    return null;
  }

  const overlay = document.createElement('div');
  overlay.className = 'workspace-profile-overlay-root';
  if (state.ui.authPanel === 'wallet-select') {
    overlay.innerHTML = renderWalletSelectorModal(state);
    bindWalletSelectorModal(overlay, controller, state);
    return overlay;
  }
  if (state.ui.authPanel === 'user-settings') {
    overlay.innerHTML = renderUserSettingsModal(state);
    bindProfileModalCloseActions(overlay, controller);
    bindUserSettingsPanel(overlay, controller);
    return overlay;
  }

  if (state.ui.authPanel === 'email-verification') {
    overlay.innerHTML = renderEmailVerificationModal(state);
    hydrateAuthSensitiveText(overlay, state);
    bindEmailVerificationPanel(overlay, controller, state);
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

  if (overlayMode === 'block-token-warning') {
    overlay.innerHTML = renderBlockTokenWarningModal(state);
    bindBlockTokenWarningModal(overlay, controller);
    return overlay;
  }

  if (overlayMode === 'mock-trading-ticket') {
    overlay.innerHTML = renderMockTradingTicketModal(state);
    bindMockTradingTicketModal(overlay, controller, state);
    return overlay;
  }

  if (overlayMode === 'mock-trading-history') {
    overlay.innerHTML = renderMockTradingHistoryModal(state);
    bindMockTradingHistoryModal(overlay, controller);
    return overlay;
  }

  if (overlayMode === 'mock-trading-pnl') {
    overlay.innerHTML = renderMockTradingPnlResumeModal(state);
    bindMockTradingPnlResumeModal(overlay, controller);
    return overlay;
  }

  if (overlayMode === 'expanded-sparkline' && expandedSparklineAddress) {
    const sparklineEntry = expandedSparkline;
    if (!sparklineEntry) {
      return overlay;
    }
    overlay.innerHTML = renderExpandedSparklineModal(state, expandedSparklineAddress);
    bindExpandedSparklineModal(overlay, controller, expandedSparklineAddress, sparklineEntry);
    return overlay;
  }

  overlay.innerHTML = renderChangePasswordModal(state);
  bindProfileModalCloseActions(overlay, controller);
  bindChangePasswordPanel(overlay, controller, state);
  return overlay;
}

function resolveWorkspaceOverlayMode(state: AppState) {
  const authPanelMode = resolveAuthPanelOverlayMode(state);
  if (authPanelMode) {
    return authPanelMode;
  }
  if (state.session.status === 'authenticated' && state.ui.blockTokenWarning) {
    return 'block-token-warning';
  }
  if (state.session.status === 'authenticated' && state.session.role === 'admin' && state.ui.mockTradingTicket) {
    return 'mock-trading-ticket';
  }
  if (state.session.status === 'authenticated' && state.session.role === 'admin' && state.ui.mockTradingHistoryOpen) {
    return 'mock-trading-history';
  }
  if (
    state.session.status === 'authenticated'
    && state.session.role === 'admin'
    && resolveMockTradingPnlResumeAddress(state)
  ) {
    return 'mock-trading-pnl';
  }

  const address = String(state.ui.expandedSparklineAddress || '').trim();
  const sparkline = address ? getExpandedTokenSparkline(state, address) : null;
  const hasExpandedSparkline = Boolean(sparkline && Array.isArray(sparkline.series) && sparkline.series.length >= 2);
  return hasExpandedSparkline ? 'expanded-sparkline' : 'none';
}

function resolveAuthPanelOverlayMode(state: AppState) {
  if (state.ui.authPanel === 'wallet-select') {
    return 'wallet-select';
  }
  if (state.ui.authPanel === 'email-verification') {
    return 'email-verification';
  }
  if (isProfileAuthPanel(state.ui.authPanel)) {
    return 'profile';
  }
  return null;
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

function bindMockTradingWalletHeaderControls(section: ParentNode, controller: AppController, state: AppState) {
  section.querySelectorAll<HTMLButtonElement>('[data-action="select-mock-trading-wallet"]').forEach((button) => {
    button.addEventListener('click', () => {
      const walletId = Number(button.dataset.walletId || '0');
      button.closest<HTMLElement>('[data-sort-wrap]')?.classList.remove('open');
      void controller.setActiveMockTradingWallet(walletId);
    });
  });

  section.querySelector<HTMLButtonElement>('[data-action="create-mock-trading-wallet"]')?.addEventListener('click', () => {
    const name = promptMockTradingWalletName('New mock wallet name');
    if (name) {
      void controller.createMockTradingWallet(name);
    }
  });

  section.querySelector<HTMLButtonElement>('[data-action="rename-mock-trading-wallet"]')?.addEventListener('click', () => {
    const wallet = getActiveMockTradingWallet(state);
    if (!wallet) {
      return;
    }
    const name = promptMockTradingWalletName('Rename mock wallet', wallet.name);
    if (name && name !== wallet.name) {
      void controller.updateMockTradingWallet(wallet.id, name);
    }
  });

  section.querySelector<HTMLButtonElement>('[data-action="default-mock-trading-wallet"]')?.addEventListener('click', () => {
    const wallet = getActiveMockTradingWallet(state);
    if (wallet) {
      void controller.setDefaultMockTradingWallet(wallet.id);
    }
  });

  section.querySelector<HTMLButtonElement>('[data-action="archive-mock-trading-wallet"]')?.addEventListener('click', () => {
    const wallet = getActiveMockTradingWallet(state);
    if (!wallet || (typeof window !== 'undefined' && !window.confirm(`Archive mock wallet "${wallet.name}"?`))) {
      return;
    }
    void controller.archiveMockTradingWallet(wallet.id);
  });
}

function promptMockTradingWalletName(label: string, value = '') {
  if (typeof window === 'undefined') {
    return null;
  }
  const name = window.prompt(label, value);
  const normalized = String(name || '').trim();
  return normalized || null;
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
            <button type="button" class="legacy-profile-modal-close" data-action="close-profile-modal" aria-label="Close dialog">&times;</button>
        </div>
        ${options.content}
      </div>
    </div>
  `;
}

function renderWalletSelectorModal(state: AppState) {
  const actionLabel = state.ui.walletSelectorMode === 'link' ? 'Connect' : 'Login';
  return `
    <div class="legacy-auth-modal" data-auth-modal="wallet-select" data-auth-modal-scope="wallet-selector">
      <div class="legacy-auth-modal-backdrop" data-action="close-wallet-selector"></div>
      <div class="legacy-auth-panel legacy-wallet-selector-panel" data-auth-panel="wallet-select" role="dialog" aria-modal="true" aria-labelledby="wallet-selector-title">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="wallet-selector-title">Choose Wallet</strong>
            <span>${escapeHtml(state.ui.walletNetworkLabel)} · message signature only</span>
          </div>
          <button type="button" class="legacy-profile-modal-close" data-action="close-wallet-selector" aria-label="Close wallet selector">X</button>
        </div>
        <div class="legacy-wallet-selector-list">
          ${state.ui.walletOptions.map((wallet) => `
            <button
              type="button"
              class="legacy-wallet-selector-option"
              data-action="select-solana-wallet"
              data-wallet-id="${escapeHtml(wallet.id)}"
              ${state.ui.busy ? 'disabled' : ''}
            >
              ${wallet.icon
                ? `<img src="${escapeHtml(wallet.icon)}" alt="" />`
                : `<span class="legacy-wallet-selector-fallback" aria-hidden="true">${escapeHtml(wallet.name.slice(0, 1).toUpperCase())}</span>`}
              <span>
                <strong>${escapeHtml(wallet.name)}</strong>
                <small>${actionLabel} with Solana account</small>
              </span>
            </button>
          `).join('')}
        </div>
        <div class="legacy-auth-panel-note legacy-wallet-selector-note">
          The wallet may ask you to approve the configured Solana network. No transaction is sent during login.
        </div>
      </div>
    </div>
  `;
}

function bindWalletSelectorModal(section: ParentNode, controller: AppController, state: AppState) {
  const panel = section.querySelector<HTMLElement>('[data-auth-panel="wallet-select"]');
  if (panel) {
    bindFocusTrap(panel);
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        controller.closeWalletSelector();
      }
    });
  }
  section.querySelectorAll<HTMLElement>('[data-action="close-wallet-selector"]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      controller.closeWalletSelector();
    });
  });
  section.querySelectorAll<HTMLButtonElement>('[data-action="select-solana-wallet"]').forEach((button) => {
    button.addEventListener('click', () => {
      const walletId = String(button.dataset.walletId || '').trim();
      if (!walletId) {
        return;
      }
      if (state.ui.walletSelectorMode === 'link') {
        void controller.connectWallet(walletId);
      } else {
        void controller.loginWithWallet(walletId);
      }
    });
  });
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

function renderMockTradingTicketModal(state: AppState) {
  const view = getMockTradingTicketView(state);
  if (!view) {
    return '';
  }

  return `
    <div class="legacy-auth-modal" data-auth-modal="mock-trading-ticket" data-auth-modal-scope="mock-trading">
      <div class="legacy-auth-modal-backdrop" data-action="close-mock-trading-ticket"></div>
      <div class="legacy-auth-panel legacy-auth-panel-mock-trading" data-auth-panel="mock-trading-ticket" role="dialog" aria-modal="true" aria-labelledby="mock-trading-ticket-title">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="mock-trading-ticket-title">${escapeHtml(view.sideLabel)}</strong>
            <span>${escapeHtml(view.symbol)} · ${escapeHtml(view.name)} · ${escapeHtml(getActiveMockTradingWalletName(state))}</span>
          </div>
          <button type="button" class="legacy-profile-modal-close" data-action="close-mock-trading-ticket" aria-label="Close dialog">X</button>
        </div>
        ${renderMockTradingTicketStats(state, view.address)}
        ${renderFlash(state)}
        <form class="mock-trading-ticket-form" data-role="mock-trading-ticket-form" data-address="${escapeHtml(view.address)}" data-side="${view.side}">
          ${view.side === 'buy' ? renderMockTradingBuyFields(state.ui.busy) : renderMockTradingSellFields(state, view.address, view.percent, state.ui.busy)}
          <div class="legacy-auth-panel-actions">
            <button type="button" class="action-button small" data-action="close-mock-trading-ticket" ${state.ui.busy ? 'disabled' : ''}>Cancel</button>
            <button type="submit" class="action-button primary" ${state.ui.busy ? 'disabled' : ''}>${view.submitLabel}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

type MockTradingTradeView = AppState['data']['mockTradingTradesByAddress'][string][number];
type MockTradingTakeProfitOrderView = NonNullable<AppState['data']['mockTradingPositionsByAddress'][string]['takeProfitOrders']>[number];

function renderMockTradingHistoryModal(state: AppState) {
  const summary = getMockTradingSummaryView(state);
  const sells = getMockTradingSellTrades(state);
  const openOrders = getMockTradingOpenSellOrders(state);
  const sellOutcomes = buildMockTradingHistorySellOutcomes(state);
  const winners = sells.filter((trade) => (sellOutcomes.get(trade.id)?.pnlUsd ?? trade.realizedPnlUsd) > 0).length;
  const losers = sells.filter((trade) => (sellOutcomes.get(trade.id)?.pnlUsd ?? trade.realizedPnlUsd) < 0).length;
  const flats = sells.length - winners - losers;
  const winRate = sells.length > 0 ? (winners / sells.length) * 100 : null;
  const rows = sells.slice(0, 30);

  return `
    <div class="legacy-auth-modal" data-auth-modal="mock-trading-history" data-auth-modal-scope="mock-trading-history">
      <div class="legacy-auth-modal-backdrop" data-action="close-mock-trading-history"></div>
      <div class="legacy-auth-panel legacy-auth-panel-mock-trading-history" data-auth-panel="mock-trading-history" role="dialog" aria-modal="true" aria-labelledby="mock-trading-history-title">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="mock-trading-history-title">Mock plays</strong>
            <span>${escapeHtml(getActiveMockTradingWalletName(state))} · Closed sells and position PnL</span>
          </div>
          <button type="button" class="legacy-profile-modal-close" data-action="close-mock-trading-history" aria-label="Close dialog">X</button>
        </div>
        <div class="mock-trading-history-stats">
          ${renderMockTradingHistoryStat('Cash', fmtMockUsdForState(state, summary?.account.cashUsd ?? null), null)}
          ${renderMockTradingHistoryStat('Equity', fmtMockUsdForState(state, summary?.totalEquityUsd ?? null), null)}
          ${renderMockTradingHistoryStat('Win rate', fmtPct(winRate), null)}
          ${renderMockTradingHistoryStat('Wins', String(winners), 'up')}
          ${renderMockTradingHistoryStat('Losses', String(losers), losers > 0 ? 'down' : null)}
          ${renderMockTradingHistoryStat('Orders', String(openOrders.length), null)}
          ${renderMockTradingHistoryStat('Flat', String(flats), null)}
        </div>
        <div class="mock-trading-history-table-wrap">
          ${openOrders.length > 0 ? renderMockTradingOpenOrdersTable(state, openOrders) : ''}
          ${rows.length > 0 ? renderMockTradingHistoryTable(state, rows, sellOutcomes) : '<div class="mock-trading-history-empty">No closed mock plays yet.</div>'}
        </div>
      </div>
    </div>
  `;
}

function resolveMockTradingPnlResumeAddress(state: AppState) {
  const address = String(state.ui.mockTradingPnlAddress || '').trim();
  return address && state.data.mockTradingPositionsByAddress[address] ? address : null;
}

function renderMockTradingPnlResumeModal(state: AppState) {
  const view = getMockTradingPnlResumeView(state);
  if (!view) {
    return '';
  }

  return `
    <div class="legacy-auth-modal" data-auth-modal="mock-trading-pnl" data-auth-modal-scope="mock-trading-pnl">
      <div class="legacy-auth-modal-backdrop" data-action="close-mock-trading-pnl"></div>
      <div class="legacy-auth-panel legacy-auth-panel-mock-trading-pnl" data-auth-panel="mock-trading-pnl" role="dialog" aria-modal="true" aria-labelledby="mock-trading-pnl-title">
        <div class="mock-trading-pnl-card" data-tone="${view.pnlTone}">
          <div class="mock-trading-pnl-head">
            ${renderMockTradingPnlAvatar(view.imageUrl, view.symbol)}
            <div class="mock-trading-pnl-title">
              <strong id="mock-trading-pnl-title">${escapeHtml(view.symbol)}</strong>
              <span>${escapeHtml(view.name)} · ${escapeHtml(getActiveMockTradingWalletName(state))}</span>
            </div>
            <button type="button" class="workspace-mock-trading-copy copy-button" data-action="copy-address" data-address="${escapeHtml(view.address)}" title="Copy contract" aria-label="Copy ${escapeHtml(view.symbol)} contract">⧉</button>
            <button type="button" class="legacy-profile-modal-close" data-action="close-mock-trading-pnl" aria-label="Close dialog">X</button>
          </div>

          <div class="mock-trading-pnl-main">
            <div class="mock-trading-pnl-number">
              <span>PNL</span>
              <strong>${escapeHtml(fmtMockUsdForState(state, view.totalPnl, { signed: true }))}</strong>
              <em>${escapeHtml(fmtPct(view.pnlPct))}</em>
            </div>
            <div class="mock-trading-pnl-stats">
              ${renderMockTradingPnlStat('Invested', fmtMockSolAmount(view.boughtSol))}
              ${renderMockTradingPnlStat('Bought @', fmtMoney(view.entryMcap))}
              ${renderMockTradingPnlStat('Position', fmtMockUsdForState(state, view.currentValue))}
              ${renderMockTradingPnlStat('MCAP', fmtMoney(view.currentMcap))}
              ${renderMockTradingPnlStat('Sold', fmtMockSolAmount(view.soldSol))}
            </div>
          </div>

          <div class="mock-trading-pnl-actions" data-address="${escapeHtml(view.address)}">
            <button type="button" class="action-button small" data-action="mock-pnl-sell" data-percent="25" ${state.ui.busy ? 'disabled' : ''}>Sell 25%</button>
            <button type="button" class="action-button small" data-action="mock-pnl-sell" data-percent="50" ${state.ui.busy ? 'disabled' : ''}>Sell 50%</button>
            <button type="button" class="action-button small danger" data-action="mock-pnl-sell" data-percent="100" ${state.ui.busy ? 'disabled' : ''}>Sell 100%</button>
          </div>

          <div class="mock-trading-pnl-chart">
            ${view.sparkline ? renderSparklineFigure(view.sparkline, view.address, { expanded: true, areaFill: true, markers: view.trades, mockSolUsdcRate: resolveLiveMockSolUsdcRate(state.data.mockTradingSummary, state.data.configs), liveMcap: view.currentMcap }) : '<div class="mock-trading-history-empty">No chart snapshot available yet.</div>'}
          </div>

          <div class="mock-trading-pnl-trades">
            ${view.trades.length > 0 ? view.trades.slice(-6).reverse().map(renderMockTradingPnlTrade).join('') : '<div class="mock-trading-history-empty">No mock trades yet.</div>'}
          </div>
        </div>
      </div>
    </div>
  `;
}

function getMockTradingPnlResumeView(state: AppState) {
  const address = resolveMockTradingPnlResumeAddress(state);
  const position = address ? getMockTradingPositionView(state, address) : null;
  if (!address || !position) {
    return null;
  }

  const token = getTrackedToken(state, address);
  const trades = getSortedMockTradingTradesForAddress(state, address);
  const totals = getMockTradingPnlTotals(position, trades);
  return {
    address,
    trades,
    ...totals,
    sparkline: getTokenSparkline(state, address),
    symbol: token?.symbol || position.symbol || address.slice(0, 8),
    name: token?.name || position.name || token?.label || address,
    imageUrl: sanitizeOptionalHttpUrl(token?.imageUrl || position.imageUrl || null),
    entryMcap: position.avgEntryMcapUsd ?? getMockTradingAverageBuyMcap(trades),
    currentMcap: resolveMockTradingCurrentMcap(position, token),
  };
}

function resolveMockTradingCurrentMcap(
  position: NonNullable<ReturnType<typeof getMockTradingPositionView>>,
  token: ReturnType<typeof getTrackedToken>,
) {
  if (position.currentMcapUsd != null) {
    return position.currentMcapUsd;
  }
  return token?.mcap ?? null;
}

function getSortedMockTradingTradesForAddress(state: AppState, address: string) {
  return [...(state.data.mockTradingTradesByAddress[address] || [])]
    .sort((left, right) => String(left.executedAt || '').localeCompare(String(right.executedAt || '')));
}

function getMockTradingPnlTotals(
  position: NonNullable<ReturnType<typeof getMockTradingPositionView>>,
  trades: MockTradingTradeView[],
) {
  const boughtUsd = trades.filter((trade) => trade.side === 'buy').reduce((sum, trade) => sum + trade.notionalUsd, 0);
  const soldUsd = trades.filter((trade) => trade.side === 'sell').reduce((sum, trade) => sum + trade.notionalUsd, 0);
  const boughtSol = trades
    .filter((trade) => trade.side === 'buy')
    .reduce((sum, trade) => sum + trade.notionalUsd / resolveMockTradeSolUsdcRate(trade), 0);
  const soldSol = trades
    .filter((trade) => trade.side === 'sell')
    .reduce((sum, trade) => sum + trade.notionalUsd / resolveMockTradeSolUsdcRate(trade), 0);
  const currentValue = position.currentValueUsd ?? null;
  const totalOutcome = soldUsd + (currentValue ?? 0);
  const netPnl = totalOutcome - boughtUsd;
  const pnlPct = boughtUsd > 0 ? (netPnl / boughtUsd) * 100 : position.priceReturnPct ?? position.unrealizedPnlPct ?? null;

  return {
    boughtUsd,
    boughtSol,
    soldUsd,
    soldSol,
    currentValue,
    netPnl,
    totalPnl: netPnl,
    pnlPct,
    pnlTone: netPnl < 0 ? 'down' : 'up',
  };
}

function renderMockTradingPnlAvatar(imageUrl: string | null, symbol: string) {
  return imageUrl
    ? `<img class="mock-trading-pnl-avatar" src="${imageUrl}" alt="${escapeHtml(symbol)}" />`
    : `<span class="mock-trading-pnl-avatar mock-trading-pnl-avatar-placeholder">${escapeHtml(symbol.slice(0, 2).toUpperCase())}</span>`;
}

function renderMockTradingPnlStat(label: string, value: string, tone?: 'up' | 'down') {
  return `
    <div ${tone ? `data-tone="${tone}"` : ''}>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderMockTradingPnlTrade(trade: MockTradingTradeView) {
  const tone = trade.side === 'sell' && trade.realizedPnlUsd < 0 ? 'down' : 'up';
  const value = trade.side === 'buy'
    ? fmtMockSolAmount(trade.notionalUsd / resolveMockTradeSolUsdcRate(trade))
    : fmtMockSolAmount(trade.realizedPnlUsd / resolveMockTradeSolUsdcRate(trade), { signed: true });
  const marketCap = trade.marketCapUsd && trade.marketCapUsd > 0 ? `MCAP ${fmtMoney(trade.marketCapUsd)}` : 'MCAP -';
  return `
    <div class="mock-trading-pnl-trade" data-side="${trade.side}" data-tone="${tone}">
      <span>${escapeHtml(trade.side.toUpperCase())}</span>
      <strong>
        ${escapeHtml(value)}
        <small>${escapeHtml(marketCap)}</small>
      </strong>
      <em>${escapeHtml(formatMockTradeTime(trade.executedAt))}</em>
    </div>
  `;
}

function getMockTradingAverageBuyMcap(trades: MockTradingTradeView[]) {
  let weightedMcap = 0;
  let weight = 0;

  for (const trade of trades) {
    if (trade.side !== 'buy' || !(trade.marketCapUsd && trade.marketCapUsd > 0) || !(trade.notionalUsd > 0)) {
      continue;
    }
    weightedMcap += trade.marketCapUsd * trade.notionalUsd;
    weight += trade.notionalUsd;
  }

  return weight > 0 ? weightedMcap / weight : null;
}

function weightedMockTradingMcap(leftValue: number | null, leftWeight: number, rightValue: number | null, rightWeight: number) {
  if (leftValue == null && rightValue == null) return null;
  if (leftValue == null) return rightValue;
  if (rightValue == null) return leftValue;
  const totalWeight = leftWeight + rightWeight;
  return totalWeight > 0 ? ((leftValue * leftWeight) + (rightValue * rightWeight)) / totalWeight : rightValue;
}

function buildMockTradingSellOutcomesForTrades(trades: MockTradingTradeView[]) {
  const outcomes = new Map<number, { entryMcapUsd: number | null; pnlUsd: number }>();
  let boughtUsd = 0;
  let soldUsd = 0;
  let quantity = 0;
  let costBasisUsd = 0;
  let entryMcapUsd: number | null = null;

  for (const trade of trades.slice().sort((left, right) => String(left.executedAt || '').localeCompare(String(right.executedAt || '')) || left.id - right.id)) {
    if (trade.side === 'buy') {
      boughtUsd += trade.notionalUsd;
      entryMcapUsd = weightedMockTradingMcap(entryMcapUsd, costBasisUsd, trade.marketCapUsd ?? null, trade.notionalUsd);
      costBasisUsd += trade.notionalUsd;
      quantity += trade.quantity;
      continue;
    }

    const quantityBeforeSell = quantity;
    soldUsd += trade.notionalUsd;
    quantity = Math.max(0, quantity - trade.quantity);
    const remainingValueUsd = quantity * trade.priceUsd;
    const totalOutcomeUsd = soldUsd + remainingValueUsd;
    const netPnlUsd = totalOutcomeUsd - boughtUsd;
    outcomes.set(trade.id, {
      entryMcapUsd,
      pnlUsd: netPnlUsd,
    });

    if (quantityBeforeSell > 0 && costBasisUsd > 0) {
      const soldRatio = Math.min(1, trade.quantity / quantityBeforeSell);
      costBasisUsd = Math.max(0, costBasisUsd * (1 - soldRatio));
    }
    if (quantity <= 0.000000001) {
      quantity = 0;
      costBasisUsd = 0;
      entryMcapUsd = null;
    }
  }

  return outcomes;
}

function buildMockTradingHistorySellOutcomes(state: AppState) {
  const outcomes = new Map<number, { entryMcapUsd: number | null; pnlUsd: number }>();
  for (const trades of Object.values(state.data.mockTradingTradesByAddress)) {
    for (const [tradeId, outcome] of buildMockTradingSellOutcomesForTrades(trades)) {
      outcomes.set(tradeId, outcome);
    }
  }
  return outcomes;
}

function getMockTradingOpenSellOrders(state: AppState) {
  return Object.values(state.data.mockTradingPositionsByAddress)
    .flatMap((position) => {
      const orders = position.takeProfitOrders?.length
        ? position.takeProfitOrders
        : position.takeProfitOrder ? [position.takeProfitOrder] : [];
      return orders.filter((order) => order.status === 'open');
    })
    .sort((left, right) => left.targetMcapUsd - right.targetMcapUsd || left.id - right.id);
}

function getMockTradingSellTrades(state: AppState) {
  return Object.values(state.data.mockTradingTradesByAddress)
    .flat()
    .filter((trade) => trade.side === 'sell')
    .sort((left, right) => {
      const rightTime = Date.parse(String(right.executedAt || ''));
      const leftTime = Date.parse(String(left.executedAt || ''));
      const timeDelta = (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      return timeDelta || right.id - left.id;
    });
}

function renderMockTradingHistoryStat(label: string, value: string, tone: 'up' | 'down' | null) {
  return `
    <div class="mock-trading-history-stat" ${tone ? `data-tone="${tone}"` : ''}>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderMockTradingOpenOrdersTable(state: AppState, orders: MockTradingTakeProfitOrderView[]) {
  return `
    <table class="mock-trading-history-table mock-trading-orders-table">
      <thead>
        <tr>
          <th>Open sell orders</th>
          <th>Target MCAP</th>
          <th>Sell</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${orders.map((order) => renderMockTradingOpenOrderRow(state, order)).join('')}
      </tbody>
    </table>
  `;
}

function renderMockTradingOpenOrderRow(state: AppState, order: MockTradingTakeProfitOrderView) {
  const token = getTrackedToken(state, order.tokenAddress);
  const position = getMockTradingPositionView(state, order.tokenAddress);
  const symbol = token?.symbol || position?.symbol || order.tokenAddress.slice(0, 8);
  const imageUrl = sanitizeOptionalHttpUrl(token?.imageUrl || position?.imageUrl || null);
  return `
    <tr>
      <td>
        <div class="mock-trading-history-token">
          ${renderMockTradingHistoryAvatar(imageUrl, symbol)}
          <strong>${escapeHtml(symbol)}</strong>
          ${renderMockTradingHistoryCopyButton(order.tokenAddress, symbol)}
        </div>
      </td>
      <td>${escapeHtml(fmtMoney(order.targetMcapUsd))}</td>
      <td>${escapeHtml(fmtPct(order.sellPercent))}</td>
      <td>${escapeHtml(formatMockTradeTime(order.createdAt))}</td>
      <td>
        <button type="button" class="action-button small" data-action="cancel-mock-take-profit-order" data-order-id="${order.id}" ${state.ui.busy ? 'disabled' : ''}>Cancel</button>
      </td>
    </tr>
  `;
}

function renderMockTradingHistoryTable(state: AppState, trades: MockTradingTradeView[], sellOutcomes: Map<number, { entryMcapUsd: number | null; pnlUsd: number }>) {
  return `
    <table class="mock-trading-history-table">
      <thead>
        <tr>
          <th>Token</th>
          <th>Bought @</th>
          <th>Sold</th>
          <th>PnL</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        ${trades.map((trade) => renderMockTradingHistoryRow(state, trade, sellOutcomes)).join('')}
      </tbody>
    </table>
  `;
}

function renderMockTradingHistoryRow(state: AppState, trade: MockTradingTradeView, sellOutcomes: Map<number, { entryMcapUsd: number | null; pnlUsd: number }>) {
  const token = getTrackedToken(state, trade.tokenAddress);
  const symbol = token?.symbol || trade.symbol || trade.tokenAddress.slice(0, 8);
  const imageUrl = sanitizeOptionalHttpUrl(token?.imageUrl || trade.imageUrl || null);
  const outcome = sellOutcomes.get(trade.id);
  const pnlUsd = outcome?.pnlUsd ?? trade.realizedPnlUsd;
  const tone = pnlUsd < 0 ? 'down' : 'up';
  return `
    <tr>
      <td>
        <div class="mock-trading-history-token">
          ${renderMockTradingHistoryAvatar(imageUrl, symbol)}
          <strong>${escapeHtml(symbol)}</strong>
          ${renderMockTradingHistoryCopyButton(trade.tokenAddress, symbol)}
        </div>
      </td>
      <td>${escapeHtml(fmtMoney(outcome?.entryMcapUsd ?? null))}</td>
      <td>${escapeHtml(fmtMockSolAmount(trade.notionalUsd / resolveMockTradeSolUsdcRate(trade)))}</td>
      <td data-tone="${tone}">${escapeHtml(fmtMockSolAmount(pnlUsd / resolveMockTradeSolUsdcRate(trade), { signed: true }))}</td>
      <td>${escapeHtml(formatMockTradeTime(trade.executedAt))}</td>
    </tr>
  `;
}

function renderMockTradingHistoryAvatar(imageUrl: string | null, symbol: string) {
  return imageUrl
    ? `<img src="${imageUrl}" alt="${escapeHtml(symbol)}" />`
    : `<span>${escapeHtml(symbol.slice(0, 2).toUpperCase())}</span>`;
}

function renderMockTradingHistoryCopyButton(address: string, symbol: string) {
  return `<button type="button" class="workspace-mock-trading-copy copy-button mock-trading-history-copy" data-action="copy-address" data-address="${escapeHtml(address)}" title="Copy contract" aria-label="Copy ${escapeHtml(symbol)} contract">⧉</button>`;
}

function formatMockTradeTime(value?: string | null) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) {
    return '-';
  }
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getMockTradingTicketView(state: AppState) {
  const ticket = state.ui.mockTradingTicket;
  if (!ticket) {
    return null;
  }

  const token = getTrackedToken(state, ticket.address);
  const position = getMockTradingPositionView(state, ticket.address);
  const symbol = token?.symbol || token?.label || position?.symbol || ticket.address.slice(0, 8);
  const name = token?.name || position?.name || token?.label || ticket.address;
  return {
    ...ticket,
    symbol,
    name,
    sideLabel: ticket.side === 'buy' ? 'Mock buy' : 'Mock sell',
    submitLabel: ticket.side === 'buy' ? 'Buy' : 'Sell',
  };
}

function renderMockTradingTicketStats(state: AppState, address: string) {
  const stats = getMockTradingTicketStats(state, address);

  return `
    <div class="mock-trading-ticket-stats">
      ${stats.map(renderMockTradingTicketStat).join('')}
    </div>
  `;
}

function getMockTradingTicketStats(state: AppState, address: string) {
  const market = getMockTradingTicketMarketValues(state, address);
  const pnl = getMockTradingTicketPnlValues(state, address);
  const summary = getMockTradingSummaryView(state);
  return [
    { label: 'priceUSD', value: fmtMoney(market.priceUsd), tone: null },
    { label: 'MCAP', value: fmtMoney(market.mcapUsd), tone: null },
    { label: 'PnL', value: `${fmtMockUsdForState(state, pnl.usd)} ${fmtPct(pnl.pct)}`, tone: pnl.tone },
    { label: 'Cash', value: fmtMockUsdForState(state, summary?.account.cashUsd ?? null), tone: null },
  ];
}

function getMockTradingTicketMarketValues(state: AppState, address: string) {
  const token = getTrackedToken(state, address);
  const position = getMockTradingPositionView(state, address);
  return {
    priceUsd: token?.priceUsd ?? position?.currentPriceUsd ?? null,
    mcapUsd: token?.mcap ?? position?.currentMcapUsd ?? null,
  };
}

function getMockTradingTicketPnlValues(state: AppState, address: string) {
  const position = getMockTradingPositionView(state, address);
  const usd = position?.unrealizedPnlUsd ?? null;
  return {
    usd,
    pct: position?.priceReturnPct ?? position?.unrealizedPnlPct ?? null,
    tone: usd != null && usd < 0 ? 'down' : 'up',
  };
}

function renderMockTradingTicketStat(stat: { label: string; value: string; tone: string | null }) {
  const toneAttr = stat.tone ? ` data-tone="${escapeHtml(stat.tone)}"` : '';
  return `<div${toneAttr}><span>${escapeHtml(stat.label)}</span><strong>${escapeHtml(stat.value)}</strong></div>`;
}

function renderMockTradingBuyFields(busy: boolean) {
  return `
    <label class="mock-trading-ticket-field">
      <span>SOL amount</span>
      <input type="number" name="notionalSol" min="0.01" step="0.01" value="1" inputmode="decimal" ${busy ? 'disabled' : ''} />
    </label>
    <div class="mock-trading-ticket-presets">
      ${[0.3, 0.5, 1, 2].map((value) => `<button type="button" data-action="mock-trade-preset" data-value="${value}" ${busy ? 'disabled' : ''}>${value} SOL</button>`).join('')}
    </div>
    <label class="mock-trading-ticket-field">
      <span>Take profit MCAP</span>
      <input type="number" name="takeProfitMcapUsd" min="1" step="1000" placeholder="optional" inputmode="decimal" ${busy ? 'disabled' : ''} />
    </label>
    <label class="mock-trading-ticket-field">
      <span>TP sell %</span>
      <input type="number" name="takeProfitSellPercent" min="1" max="100" step="1" value="100" inputmode="decimal" ${busy ? 'disabled' : ''} />
    </label>
  `;
}

function renderMockTradingSellFields(state: AppState, address: string, percent: number | undefined, busy: boolean) {
  const value = typeof percent === 'number' && Number.isFinite(percent) ? Math.min(100, Math.max(1, percent)) : 100;
  return `
    <label class="mock-trading-ticket-field">
      <span>Position percent</span>
      <input type="number" name="percent" min="1" max="100" step="1" value="${value}" inputmode="decimal" ${busy ? 'disabled' : ''} />
    </label>
    <div class="mock-trading-ticket-presets">
      ${[25, 50, 100].map((item) => `<button type="button" data-action="mock-trade-preset" data-value="${item}" ${busy ? 'disabled' : ''}>${item}%</button>`).join('')}
    </div>
    ${renderMockTradingSellPreview(state, address, value, null, 'now')}
    <div class="mock-trading-ticket-order-block">
      <span>Sell order</span>
      <label class="mock-trading-ticket-field">
        <span>Target MCAP</span>
        <input type="number" name="orderTargetMcapUsd" min="1" step="1000" placeholder="optional" inputmode="decimal" ${busy ? 'disabled' : ''} />
      </label>
      <label class="mock-trading-ticket-field">
        <span>Order sell %</span>
        <input type="number" name="orderSellPercent" min="1" max="100" step="1" value="${value}" inputmode="decimal" ${busy ? 'disabled' : ''} />
      </label>
      ${renderMockTradingSellPreview(state, address, value, null, 'order')}
      <button type="button" class="action-button small" data-action="mock-sell-order-submit" ${busy ? 'disabled' : ''}>Place order</button>
    </div>
  `;
}

function renderMockTradingSellPreview(
  state: AppState,
  address: string,
  percent: number,
  targetMcapUsd: number | null,
  mode: 'now' | 'order',
) {
  const preview = getMockTradingSellPreview(state, address, percent, targetMcapUsd, mode);
  const role = mode === 'now' ? 'sell-preview' : 'sell-order-preview';
  const heading = mode === 'now' ? 'Sell preview' : 'Sell order preview';
  if (!preview.available) {
    return `
      <div class="mock-trading-ticket-preview" data-role="${role}">
        <span>${heading}</span>
        <p>${escapeHtml(preview.message)}</p>
      </div>
    `;
  }

  const toneAttr = preview.pnlTone ? ` data-tone="${preview.pnlTone}"` : '';
  return `
    <div class="mock-trading-ticket-preview" data-role="${role}">
      <span>${heading}</span>
      <div><em>Receive</em><strong>${escapeHtml(preview.receiveSol)}</strong></div>
      <div${toneAttr}><em>Realized PnL</em><strong>${escapeHtml(preview.pnlSol)}</strong></div>
      <div><em>Remaining</em><strong>${escapeHtml(preview.remainingPct)}</strong></div>
    </div>
  `;
}

function getMockTradingSellPreview(
  state: AppState,
  address: string,
  percent: number,
  targetMcapUsd: number | null,
  mode: 'now' | 'order',
) {
  const position = getMockTradingPositionView(state, address);
  if (!position || !(position.quantity > 0)) {
    return { available: false as const, message: 'No open mock position.' };
  }

  const safePercent = clampMockTradingPercent(percent);
  const currentValueUsd = Number(position.currentValueUsd);
  const costBasisUsd = Number(position.costBasisUsd);
  if (!(currentValueUsd > 0) || !(costBasisUsd >= 0)) {
    return { available: false as const, message: 'Position value is not available yet.' };
  }

  let baseValueUsd = currentValueUsd;
  if (mode === 'order') {
    if (!(targetMcapUsd != null && targetMcapUsd > 0)) {
      return { available: false as const, message: 'Enter a target MCAP to preview the order.' };
    }
    const currentMcapUsd = Number(position.currentMcapUsd);
    if (!(currentMcapUsd > 0)) {
      return { available: false as const, message: 'Current MCAP is not available for order preview.' };
    }
    baseValueUsd = currentValueUsd * (targetMcapUsd / currentMcapUsd);
  }

  const sellRatio = safePercent / 100;
  const receiveUsd = baseValueUsd * sellRatio;
  const pnlUsd = receiveUsd - (costBasisUsd * sellRatio);
  return {
    available: true as const,
    receiveSol: fmtMockUsdForState(state, receiveUsd),
    pnlSol: fmtMockUsdForState(state, pnlUsd, { signed: true }),
    pnlTone: pnlUsd < 0 ? 'down' : 'up',
    remainingPct: `${Math.max(0, 100 - safePercent).toFixed(0)}%`,
  };
}

function clampMockTradingPercent(value: number) {
  return Number.isFinite(value) ? Math.min(100, Math.max(1, value)) : 100;
}

function renderExpandedSparklineModal(state: AppState, address: string) {
  const token = getTrackedToken(state, address);
  const sparkline = getExpandedTokenSparkline(state, address);
  if (!sparkline) {
    return '';
  }

  const symbol = token?.symbol || token?.label || address.slice(0, 8);
  const name = token?.name || token?.label || address;
  const stats = getExpandedSparklineStats(sparkline);

  return `
    <div class="legacy-auth-modal" data-auth-modal="expanded-sparkline" data-auth-modal-scope="sparkline">
      <div class="legacy-auth-modal-backdrop" data-action="close-expanded-sparkline"></div>
      <div class="legacy-auth-panel legacy-auth-panel-expanded-sparkline" data-auth-panel="expanded-sparkline" role="dialog" aria-modal="true" aria-labelledby="expanded-sparkline-title">
        <div class="expanded-sparkline-toolbar">
          <div class="expanded-sparkline-identity">
            <strong id="expanded-sparkline-title">${escapeHtml(symbol)}</strong>
            <span>${escapeHtml(name)}</span>
          </div>
          <div class="expanded-sparkline-popover-subhead">
            <span>MCAP ${escapeHtml(fmtMoney(stats.latestValue))}</span>
            <span>${escapeHtml(stats.spanLabel)} span</span>
            <span>${escapeHtml(stats.resolutionLabel)}</span>
          </div>
          <button type="button" class="legacy-profile-modal-close" data-action="close-expanded-sparkline" aria-label="Close dialog">X</button>
        </div>
        <div class="expanded-sparkline-chart${sparkline.loading ? ' is-loading' : ''}">
          ${renderSparklineFigure(sparkline, address, { expanded: true, markers: state.data.mockTradingTradesByAddress[address] || [], mockSolUsdcRate: resolveLiveMockSolUsdcRate(state.data.mockTradingSummary, state.data.configs), liveMcap: token?.mcap ?? null })}
          ${sparkline.loading ? '<span class="expanded-sparkline-loading" role="status" aria-label="Loading full chart"><span class="expanded-sparkline-loading-spinner" aria-hidden="true"></span></span>' : ''}
        </div>
        <div class="expanded-sparkline-footnote">${sparkline.loading ? 'Loading full available history.' : `Updated ${escapeHtml(stats.updatedLabel)}.`} Hover for approximate market cap and time.</div>
      </div>
    </div>
  `;
}

function getExpandedSparklineStats(sparkline: NonNullable<ReturnType<typeof getTokenSparkline>>) {
  const series = Array.isArray(sparkline.series) ? sparkline.series : [];
  const latestValue = series.length > 0 ? series[series.length - 1] : null;
  const updatedLabel = sparkline.generatedAt
    ? new Date(sparkline.generatedAt).toLocaleString()
    : 'unknown';
  const spanLabel = sparkline.effectiveHours != null && Number.isFinite(sparkline.effectiveHours)
    ? `${Math.max(1, Math.round(sparkline.effectiveHours / 24))}d`
    : '14d';
  const resolutionLabel = sparkline.granularityMinutes != null && Number.isFinite(sparkline.granularityMinutes)
    ? `${Math.round(sparkline.granularityMinutes)}m`
    : '-';

  return {
    latestValue,
    updatedLabel,
    spanLabel,
    resolutionLabel,
  };
}

function bindExpandedSparklineModal(
  section: ParentNode,
  controller: AppController,
  address: string,
  sparkline: ReturnType<typeof getTokenSparkline>,
) {
  if (!sparkline) {
    return;
  }

  section.querySelectorAll<HTMLElement>('[data-action="close-expanded-sparkline"]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      controller.closeExpandedSparkline();
    });
  });
  bindSparklineHover(section, { [address]: sparkline });
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

function bindMockTradingTicketModal(section: ParentNode, controller: AppController, state: AppState) {
  section.querySelectorAll<HTMLElement>('[data-action="close-mock-trading-ticket"]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      controller.closeMockTradingTicket();
    });
  });

  section.querySelectorAll<HTMLButtonElement>('[data-action="mock-trade-preset"]').forEach((button) => {
    button.addEventListener('click', () => {
      const form = button.closest<HTMLFormElement>('form[data-role="mock-trading-ticket-form"]');
      const input = form?.querySelector<HTMLInputElement>('input[name="notionalSol"], input[name="percent"]');
      if (input) {
        input.value = button.dataset.value || input.value;
      }
      if (form?.dataset.side === 'sell') {
        updateMockTradingSellPreviews(form, state);
      }
    });
  });

  const ticketForm = section.querySelector<HTMLFormElement>('form[data-role="mock-trading-ticket-form"]');
  if (ticketForm?.dataset.side === 'sell') {
    bindMockTradingSellPreviewInputs(ticketForm, state);
    updateMockTradingSellPreviews(ticketForm, state);
  }
  ticketForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitMockTradingTicketForm(event.currentTarget as HTMLFormElement, controller);
  });
  bindPointerSafeModalButton(ticketForm?.querySelector<HTMLButtonElement>('button[type="submit"]') || null, () => {
    if (ticketForm) {
      submitMockTradingTicketForm(ticketForm, controller);
    }
  });

  const sellOrderButton = section.querySelector<HTMLButtonElement>('[data-action="mock-sell-order-submit"]');
  bindPointerSafeModalButton(sellOrderButton, () => {
    const form = sellOrderButton?.closest<HTMLFormElement>('form[data-role="mock-trading-ticket-form"]');
    const address = form?.dataset.address || '';
    if (!form || !address) {
      return;
    }
    const targetMcapUsd = Number(form.querySelector<HTMLInputElement>('input[name="orderTargetMcapUsd"]')?.value || '0');
    const sellPercent = Number(form.querySelector<HTMLInputElement>('input[name="orderSellPercent"]')?.value || '0');
    void controller.submitMockTradingSellOrder(address, targetMcapUsd, sellPercent);
  });
}

function bindMockTradingSellPreviewInputs(form: HTMLFormElement, state: AppState) {
  form.querySelectorAll<HTMLInputElement>('input[name="percent"], input[name="orderTargetMcapUsd"], input[name="orderSellPercent"]').forEach((input) => {
    input.addEventListener('input', () => updateMockTradingSellPreviews(form, state));
    input.addEventListener('change', () => updateMockTradingSellPreviews(form, state));
  });
}

function updateMockTradingSellPreviews(form: HTMLFormElement, state: AppState) {
  const address = form.dataset.address || '';
  if (!address) {
    return;
  }

  const sellPercent = Number(form.querySelector<HTMLInputElement>('input[name="percent"]')?.value || '0');
  const orderPercent = Number(form.querySelector<HTMLInputElement>('input[name="orderSellPercent"]')?.value || '0');
  const targetMcapRaw = form.querySelector<HTMLInputElement>('input[name="orderTargetMcapUsd"]')?.value || '';
  const targetMcapUsd = targetMcapRaw.trim() ? Number(targetMcapRaw) : null;
  const sellPreview = form.querySelector<HTMLElement>('[data-role="sell-preview"]');
  const orderPreview = form.querySelector<HTMLElement>('[data-role="sell-order-preview"]');
  if (sellPreview) {
    sellPreview.outerHTML = renderMockTradingSellPreview(state, address, sellPercent, null, 'now');
  }
  if (orderPreview) {
    orderPreview.outerHTML = renderMockTradingSellPreview(state, address, orderPercent, targetMcapUsd, 'order');
  }
}

function submitMockTradingTicketForm(form: HTMLFormElement, controller: AppController) {
  const address = form.dataset.address || '';
  const side = form.dataset.side;
  if (!address) {
    return;
  }
  if (side === 'buy') {
    const notionalSol = Number(form.querySelector<HTMLInputElement>('input[name="notionalSol"]')?.value || '0');
    const targetMcapRaw = form.querySelector<HTMLInputElement>('input[name="takeProfitMcapUsd"]')?.value || '';
    const sellPercentRaw = form.querySelector<HTMLInputElement>('input[name="takeProfitSellPercent"]')?.value || '';
    const takeProfit = targetMcapRaw.trim()
      ? {
        targetMcapUsd: Number(targetMcapRaw),
        sellPercent: sellPercentRaw.trim() ? Number(sellPercentRaw) : 100,
      }
      : undefined;
    void controller.submitMockTradingBuy(address, notionalSol, takeProfit);
    return;
  }

  const percent = Number(form.querySelector<HTMLInputElement>('input[name="percent"]')?.value || '0');
  void controller.submitMockTradingSell(address, percent);
}

function bindPointerSafeModalButton(button: HTMLButtonElement | null, handler: () => void) {
  if (!button) {
    return;
  }

  let pointerHandled = false;
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || button.disabled) {
      return;
    }
    pointerHandled = true;
    event.preventDefault();
    event.stopPropagation();
    handler();
    window.setTimeout(() => {
      pointerHandled = false;
    }, 350);
  });
  button.addEventListener('click', (event) => {
    if (pointerHandled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    handler();
  });
}

function bindMockTradingHistoryModal(section: ParentNode, controller: AppController) {
  section.querySelectorAll<HTMLElement>('[data-action="close-mock-trading-history"]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      controller.closeMockTradingHistory();
    });
  });

  section.querySelectorAll<HTMLButtonElement>('[data-action="cancel-mock-take-profit-order"]').forEach((button) => {
    button.addEventListener('click', () => {
      const orderId = Number(button.dataset.orderId || '0');
      void controller.cancelMockTradingTakeProfitOrder(orderId);
    });
  });

  bindCopyButtons(section);
}

function bindMockTradingPnlResumeModal(section: ParentNode, controller: AppController) {
  section.querySelectorAll<HTMLElement>('[data-action="close-mock-trading-pnl"]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      controller.closeMockTradingPnlResume();
    });
  });

  const address = section.querySelector<HTMLElement>('[data-auth-panel="mock-trading-pnl"]')
    ?.closest<HTMLElement>('[data-auth-modal-scope="mock-trading-pnl"]')
    ?.querySelector<HTMLElement>('[data-action="copy-address"]')
    ?.dataset.address || '';
  const sparkline = address ? getTokenSparkline(controller.state, address) : null;
  if (address && sparkline) {
    bindSparklineHover(section, { [address]: sparkline });
  }
  section.querySelectorAll<HTMLButtonElement>('[data-action="mock-pnl-sell"]').forEach((button) => {
    bindPointerSafeModalButton(button, () => {
      const percent = Number(button.dataset.percent || '0');
      const panel = button.closest<HTMLElement>('.mock-trading-pnl-actions');
      const tokenAddress = panel?.dataset.address || '';
      void controller.submitMockTradingSell(tokenAddress, percent);
    });
  });
  bindCopyButtons(section);
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
  bindWalletSelectorModal(section, controller, state);
  return section;
}

function renderLegacyAuthPanels(state: AppState) {
  return [
    state.ui.authPanel === 'wallet-select' ? renderWalletSelectorModal(state) : '',
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
  section.querySelector<HTMLButtonElement>('[data-action="login-with-wallet"]')?.addEventListener('click', () => {
    void controller.loginWithWallet();
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

function isLoginFlashErrorMessage(message: string) {
  return matchesMessage(message, {
    exact: [
      'Email is required.',
      'Enter a valid email address.',
      'Password is required.',
      'Incorrect email or password. Check your credentials and try again.',
    ],
    fragments: [
      'Incorrect email or password',
      'temporarily locked',
      'deactivated',
      'not verified',
      'wallet',
      'Wallet',
      'saved session is no longer valid',
      'Unable to reach the server',
      'You are using the old password',
    ],
  });
}

function isLoginFlashNoticeMessage(message: string) {
  return matchesMessage(message, {
    noticeSet: LOGIN_RELEVANT_NOTICES,
    fragments: ['wallet', 'Wallet', 'Sign the wallet message'],
  });
}

function renderLoginFlash(state: AppState) {
  const message = state.ui.error ?? state.ui.notice ?? '';
  if (!message) {
    return '';
  }

  const isLoginError = isLoginFlashErrorMessage(message);
  const isLoginNotice = isLoginFlashNoticeMessage(message);
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
        <div class="legacy-login-social-copy">Google signup or linked Discord</div>
        <div class="legacy-login-social-actions">
          <button type="button" class="legacy-btn legacy-login-social-btn" data-action="start-social-login" data-provider="google" ${state.ui.busy ? 'disabled' : ''}>
            <span class="legacy-login-social-icon" aria-hidden="true">${renderIdentityProviderMark('google')}</span>
            <span>CONTINUE WITH GOOGLE</span>
          </button>
          <button type="button" class="legacy-btn legacy-login-social-btn" data-action="start-social-login" data-provider="discord" ${state.ui.busy ? 'disabled' : ''}>
            <span class="legacy-login-social-icon" aria-hidden="true">${renderIdentityProviderMark('discord')}</span>
            <span>CONTINUE WITH DISCORD</span>
          </button>
        </div>
      </div>
      <div class="legacy-login-wallet-block">
        <div class="legacy-login-social-copy">Token-gated wallet</div>
        <button type="button" class="legacy-btn legacy-login-wallet-btn" data-action="login-with-wallet" ${state.ui.busy ? 'disabled' : ''}>
          <span class="legacy-login-wallet-icon" aria-hidden="true">${renderWalletProviderMark()}</span>
          <span>LOGIN WITH WALLET</span>
        </button>
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
  profileCompletion?: boolean;
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
          ? 'Use the local dev verification link shown above. After confirmation, the account email can be used for email and password login.'
          : options.emailSendFailed
            ? 'Try sending the verification link again after fixing email delivery.'
            : options.profileCompletion
              ? 'Open the email and confirm your address. After that, email and password login will be available for this account.'
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
  const isProfileCompletionNotice = Boolean(state.ui.pendingVerificationEmail && state.ui.notice?.includes('Account details saved'));
  const isPostRegisterNotice = Boolean(
    state.ui.pendingVerificationEmail
    && (
      state.ui.notice?.includes('Account created')
      || isProfileCompletionNotice
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
          ${renderEmailVerificationStatusCards({ emailSendFailed, hasLocalDevLink, profileCompletion: isProfileCompletionNotice })}
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
  return plan.description || (plan.accessDays >= 30 ? 'Monthly access' : 'Plan access');
}

function renderPublicBillingPlanValueLine(
  plan: AppState['billing']['plans'][number],
  recommended: boolean,
  shortestPlan: AppState['billing']['plans'][number] | null,
) {
  const dailyRate = formatBillingDailyRate(getPlanDisplayAmount(plan), plan.accessDays);
  const shortestDailyRate = shortestPlan ? formatBillingDailyRate(getPlanDisplayAmount(shortestPlan), shortestPlan.accessDays) : null;
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
      ${renderBillingPriceRow(plan, 'legacy-public-plan-price-row', 'legacy-public-plan-price')}
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
      ${renderBillingPriceRow(plan, 'legacy-profile-billing-price-row', 'legacy-profile-billing-price')}
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
  if (!value) return 'No Expire';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'No Expire';
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

function formatCompactEmailVerificationStatus(state: AppState) {
  if (!state.session.isEmailVerified) {
    return 'pending';
  }
  if (!state.session.emailVerifiedAt) {
    return 'verified';
  }
  const parsed = new Date(state.session.emailVerifiedAt);
  if (!Number.isFinite(parsed.getTime())) {
    return 'verified';
  }
  return `verified ${parsed.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}`;
}

function maskAccountEmail(value: string | null) {
  const email = String(value || '').trim();
  const walletMatch = email.match(/^(wallet_)([^@]+)(@wallet\.local)$/i);
  if (!walletMatch) {
    return email || '-';
  }
  const middle = walletMatch[2] || '';
  if (middle.length <= 8) {
    return email;
  }
  return `${walletMatch[1]}${middle.slice(0, 3)}...${middle.slice(-4)}${walletMatch[3]}`;
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

function trimFixedDecimals(value: number, maximumFractionDigits: number) {
  return value
    .toFixed(maximumFractionDigits)
    .replace(/\.?0+$/, '');
}

function formatCompactTokenBalance(value: string | null | undefined) {
  const normalized = String(value || '').replace(/,/g, '').trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    return value || '-';
  }

  const absAmount = Math.abs(amount);
  if (absAmount >= 1_000_000_000) {
    return `${trimFixedDecimals(amount / 1_000_000_000, 2)}B`;
  }
  if (absAmount >= 1_000_000) {
    return `${trimFixedDecimals(amount / 1_000_000, 2)}M`;
  }
  if (absAmount >= 1_000) {
    return `${trimFixedDecimals(amount / 1_000, 2)}K`;
  }
  if (absAmount >= 1) {
    return trimFixedDecimals(amount, 2);
  }
  return trimFixedDecimals(amount, 6);
}

function getPlanDisplayAmount(plan: AppState['billing']['plans'][number]) {
  return plan.discountAvailable && plan.discountedAmountMinor != null
    ? plan.discountedAmountMinor
    : plan.amountMinor;
}

function renderBillingPriceRow(
  plan: AppState['billing']['plans'][number],
  rowClass: string,
  priceClass: string,
) {
  const displayAmount = getPlanDisplayAmount(plan);
  const discountLabel = plan.discountAvailable ? `-${plan.discountPercent || 0}% OFF` : '';
  return `
    ${plan.discountAvailable ? `
      <div class="legacy-token-discount-badge">${escapeHtml(discountLabel)}</div>
    ` : ''}
    <div class="${rowClass} ${plan.discountAvailable ? 'has-discount' : ''}">
      <span>${escapeHtml(String(plan.currencyCode || '').trim().toUpperCase())}</span>
      ${plan.discountAvailable ? `<del>${escapeHtml(formatBillingMajorAmount(plan.amountMinor))}</del>` : ''}
      <strong class="legacy-billing-plan-price ${priceClass}">${escapeHtml(formatBillingMajorAmount(displayAmount))}</strong>
    </div>
    ${plan.discountAvailable ? `
      <div class="legacy-token-discount-line">${escapeHtml('Token holder discount applied')}</div>
    ` : ''}
  `;
}

function getTokenTierLabel(tier: string | null) {
  if (tier === 'unlimited') return 'Unlimited holder';
  if (tier === 'launch_free') return 'Launch free';
  const discountPercent = getDiscountPercentFromTier(tier);
  if (discountPercent > 0) return `${discountPercent}% discount`;
  return 'No token tier';
}

function getDiscountPercentFromTier(tier: string | null | undefined) {
  const match = String(tier || '').trim().toLowerCase().match(/^discount_(100|[1-9]\d?)$/);
  return match ? Number(match[1]) : 0;
}

function renderTokenEntitlementStrip(state: AppState) {
  const tier = state.session.tokenTier || 'none';
  const checkedLabel = formatDateTime(state.session.tokenSnapshotCheckedAt);
  const balanceLabel = formatCompactTokenBalance(state.session.tokenBalanceUi);
  return `
    <div class="legacy-token-entitlement-strip" data-tier="${escapeHtml(tier)}">
      <div>
        <span>Token Tier</span>
        <strong>${escapeHtml(getTokenTierLabel(tier))}</strong>
      </div>
      <div>
        <span>Balance</span>
        <strong title="${escapeHtml(state.session.tokenBalanceUi || balanceLabel)}">${escapeHtml(balanceLabel)}</strong>
      </div>
      <div>
        <span>Checked</span>
        <strong>${escapeHtml(checkedLabel)}</strong>
      </div>
    </div>
  `;
}

function hasTokenEntitlementState(state: AppState) {
  const tier = String(state.session.tokenTier || '').trim().toLowerCase();
  return Boolean(
    (tier && tier !== 'none')
    || state.session.tokenBalanceRaw
    || state.session.tokenBalanceUi
    || state.session.tokenSnapshotCheckedAt
    || state.session.tokenDiscountPercent > 0
  );
}

function getTokenTierShortLabel(state: AppState) {
  const discountPercent = state.session.tokenDiscountPercent || getDiscountPercentFromTier(state.session.tokenTier);
  if (discountPercent > 0) {
    return `${discountPercent}% off`;
  }
  if (state.session.tokenTier === 'unlimited') {
    return 'Unlimited';
  }
  if (state.session.tokenTier === 'launch_free') {
    return 'Free';
  }
  return '-';
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

function renderWalletProviderMark() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M5.5 7.5h12.25c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5.5c-1.1 0-2-.9-2-2v-10c0-1.1.9-2 2-2h10.25c.83 0 1.5.67 1.5 1.5v1.5"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.8"
      />
      <path
        d="M16.75 13h.01"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="3"
      />
    </svg>
  `;
}

function renderAccountAccessSummaryCard(state: AppState) {
  const statusLabel = getAccessStatusLabel(state);
  const expiryLabel = formatAccessDate(state.session.accessExpiresAt);
  const sourceLabel = state.session.accessSource
    ? `${state.session.accessSource.slice(0, 1).toUpperCase()}${state.session.accessSource.slice(1)}`
    : '-';
  const remainingLabel = state.session.accessDaysRemaining == null
    ? 'Unlimited'
    : `${state.session.accessDaysRemaining} day${state.session.accessDaysRemaining === 1 ? '' : 's'}`;
  const username = escapeHtml(state.session.username ?? '-');
  const email = escapeHtml(maskAccountEmail(state.session.email));
  const role = escapeHtml(formatUserRole(state.session.role));
  const emailStatus = escapeHtml(formatCompactEmailVerificationStatus(state));
  const initialsSource = (state.session.username ?? state.session.email ?? 'U').trim();
  const avatarText = escapeHtml((initialsSource.slice(0, 2) || 'U').toUpperCase());
  const walletButtonLabel = hasTokenEntitlementState(state) ? 'REFRESH' : 'CONNECT';
  const tokenTierLabel = getTokenTierShortLabel(state);
  const balanceLabel = formatCompactTokenBalance(state.session.tokenBalanceUi);
  const checkedLabel = formatDateTime(state.session.tokenSnapshotCheckedAt);

  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide legacy-user-identity-access-card">
      <div class="legacy-account-access-topline">
        <div class="legacy-account-access-main">
          <div class="legacy-account-access-avatar">${avatarText}</div>
          <div class="legacy-account-access-copy">
            <div class="legacy-account-access-primary">
              <strong>${username}</strong>
              <span class="legacy-account-access-chip">${role}</span>
              <span>${emailStatus}</span>
            </div>
            <div class="legacy-account-access-wallet">${email}</div>
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
        <div class="legacy-account-access-item">
          <span>Source</span>
          <strong>${escapeHtml(sourceLabel)}</strong>
        </div>
        <div class="legacy-account-access-item">
          <span>Token Tier</span>
          <strong class="legacy-account-access-token-tier">${escapeHtml(tokenTierLabel)}</strong>
        </div>
        <div class="legacy-account-access-item">
          <span>Balance</span>
          <strong title="${escapeHtml(state.session.tokenBalanceUi || balanceLabel)}">${escapeHtml(balanceLabel)}</strong>
        </div>
        <div class="legacy-account-access-actions">
          <button type="button" class="legacy-btn legacy-btn-soft-accent legacy-account-access-wallet-btn" data-action="connect-wallet" ${state.ui.busy ? 'disabled' : ''}>${walletButtonLabel}</button>
          <button type="button" class="legacy-btn legacy-btn-soft-accent legacy-account-access-billing-btn" data-action="focus-billing-plans">BILLING</button>
        </div>
      </div>
      ${checkedLabel === '-' ? '' : `<div class="legacy-account-access-note">Balance last checked ${escapeHtml(checkedLabel)}</div>`}
    </div>
  `;
}

function renderAccountProfileCard(state: AppState) {
  const username = escapeHtml(state.session.username ?? '');
  const isWalletOnlyAccount = /^wallet_[^@]+@wallet\.local$/i.test(String(state.session.email || '').trim());
  const completionCopy = isWalletOnlyAccount
    ? 'Add a real email and password before token-only access disappears.'
    : 'Update the public username used by this account.';

  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide legacy-account-profile-card ${isWalletOnlyAccount ? 'is-wallet-completion' : 'is-username-only'}">
      <div class="legacy-user-settings-card-head">
        <strong>Profile</strong>
        <span>${escapeHtml(completionCopy)}</span>
      </div>
      <form class="legacy-auth-panel-form legacy-account-profile-form" data-role="account-profile-form" novalidate>
        <label>
          <span>Username</span>
          <input name="username" type="text" value="${username}" minlength="3" maxlength="32" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" ${state.ui.busy ? 'disabled' : ''} required />
        </label>
        ${isWalletOnlyAccount ? `
          <label>
            <span>Email</span>
            <input name="email" type="email" maxlength="${LOGIN_EMAIL_MAX_LENGTH}" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" ${state.ui.busy ? 'disabled' : ''} required />
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" minlength="8" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" ${state.ui.busy ? 'disabled' : ''} required />
          </label>
          <label>
            <span>Confirm Password</span>
            <input name="confirmPassword" type="password" minlength="8" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" ${state.ui.busy ? 'disabled' : ''} required />
          </label>
        ` : ''}
        <div class="legacy-auth-panel-actions legacy-user-settings-actions">
          <button type="submit" class="legacy-btn legacy-btn-outline-accent" ${state.ui.busy ? 'disabled' : ''}>
            ${state.ui.busy ? 'SAVING...' : isWalletOnlyAccount ? 'COMPLETE ACCOUNT' : 'SAVE PROFILE'}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderUserLinkedIdentitiesCard(
  state: AppState,
  options?: { allowConnectActions?: boolean; allowUnlinkActions?: boolean; embedded?: boolean },
) {
  const allowConnectActions = options?.allowConnectActions !== false;
  const allowUnlinkActions = options?.allowUnlinkActions === true;
  const loadingMessage = !state.identities.loaded && !state.identities.error
    ? 'Loading linked identity status...'
    : null;
  const content = `
    ${state.identities.error ? `
      <div class="legacy-auth-panel-note" data-state="error">${escapeHtml(state.identities.error)}</div>
    ` : ''}
    ${loadingMessage ? `
      <div class="legacy-auth-panel-note">${escapeHtml(loadingMessage)}</div>
    ` : `
      <div class="legacy-linked-identity-list">
        ${state.identities.providers.map((provider) => renderLinkedIdentityRow(
          state,
          provider,
          { allowConnectActions, allowUnlinkActions },
        )).join('')}
      </div>
    `}
  `;

  if (options?.embedded) {
    return content;
  }

  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide">
      <div class="legacy-user-settings-card-head">
        <strong>Connected Identities</strong>
        <span>Google can create an account directly. Other providers must first be linked here.</span>
      </div>
      ${content}
    </div>
  `;
}

function renderLinkedIdentityRow(
  state: AppState,
  provider: LinkedIdentityEntry,
  options: { allowConnectActions: boolean; allowUnlinkActions: boolean },
) {
  const providerStatus = provider.linked
    ? `Linked ${formatDateTime(provider.linkedAt)}`
    : provider.configured
      ? 'Not linked yet'
      : 'Missing OAuth config';
  const providerDescription = provider.providerDisplayName
    || provider.providerEmail
    || (provider.configured ? 'Ready for linking' : 'Provider unavailable');
  return `
    <div class="legacy-linked-identity-row ${provider.linked ? 'is-linked' : ''}">
      <div class="legacy-linked-identity-provider-mark">${renderIdentityProviderMark(provider.provider)}</div>
      <div class="legacy-linked-identity-main">
        <strong>${escapeHtml(provider.label)}</strong>
        <span>${escapeHtml(provider.linked ? providerDescription : providerStatus)}</span>
      </div>
      <div class="legacy-linked-identity-side">
        ${renderIdentityConnectAction(provider, options.allowConnectActions)}
        ${renderIdentityUnlinkAction(state, provider, options.allowUnlinkActions)}
      </div>
    </div>
  `;
}

function renderIdentityConnectAction(provider: LinkedIdentityEntry, allowConnectActions: boolean) {
  if (provider.linked || !allowConnectActions) {
    return '';
  }
  return `
    <button
      type="button"
      class="legacy-btn legacy-btn-soft-accent legacy-linked-identity-connect"
      data-action="start-social-link"
      data-provider="${escapeHtml(provider.provider)}"
      ${provider.configured ? '' : 'disabled'}
    >CONNECT</button>
  `;
}

function renderIdentityUnlinkAction(state: AppState, provider: LinkedIdentityEntry, allowUnlinkActions: boolean) {
  if (!provider.linked || !allowUnlinkActions) {
    return '';
  }
  if (state.ui.pendingIdentityUnlinkProvider === provider.provider) {
    return renderIdentityUnlinkForm(state, provider);
  }
  return `
    <button
      type="button"
      class="legacy-btn legacy-btn-outline-accent legacy-linked-identity-unlink"
      data-action="open-social-unlink"
      data-provider="${escapeHtml(provider.provider)}"
      title="${escapeHtml(provider.unlinkBlockedReason || `Unlink ${provider.label}`)}"
      ${state.ui.busy || !provider.canUnlink ? 'disabled' : ''}
    >${provider.canUnlink ? `UNLINK ${escapeHtml(provider.label.toUpperCase())}` : 'SET PASSWORD FIRST'}</button>
  `;
}

function renderIdentityUnlinkForm(state: AppState, provider: LinkedIdentityEntry) {
  return `
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
  `;
}

function renderUserSecurityCard(state: AppState) {
  const otpStatus = !state.identities.hasPasswordLogin
    ? 'Google sign-in is active. Add a password by email if you also want traditional login or identity unlinking.'
    : state.session.isEmailVerified
    ? 'Login still requires the email verification code step.'
    : 'Verify the account email before using recovery and login features normally.';
  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide legacy-security-inline-card">
      <div class="legacy-security-inline-head">
        <div class="legacy-security-inline-copy">
          <strong>Sign-in & Security</strong>
          <span>${escapeHtml(otpStatus)}</span>
        </div>
        <div class="legacy-auth-panel-actions legacy-user-settings-actions">
          ${state.identities.hasPasswordLogin ? `
            <button type="button" class="legacy-btn legacy-btn-outline-accent" data-action="open-change-password-from-user-settings" ${state.ui.busy ? 'disabled' : ''}>CHANGE PASSWORD</button>
          ` : `
            <button type="button" class="legacy-btn legacy-btn-outline-accent" data-action="add-password-by-email" ${state.ui.busy ? 'disabled' : ''}>ADD PASSWORD</button>
          `}
        </div>
      </div>
      ${renderUserLinkedIdentitiesCard(state, { allowUnlinkActions: true, embedded: true })}
    </div>
  `;
}

function renderBillingTokenAccessNotice(state: AppState) {
  if (state.session.tokenTier !== 'unlimited') {
    return '';
  }

  const balance = state.session.tokenBalanceUi
    ? formatCompactTokenBalance(state.session.tokenBalanceUi)
    : 'the required amount of';
  return `
    <div class="legacy-token-billing-notice" data-tier="unlimited">
      <strong>Unlimited token access active</strong>
      <span>You hold ${escapeHtml(balance)} tokens, so this account already has unlimited bot access while the balance stays eligible. You do not need to buy a plan.</span>
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
        ${renderBillingTokenAccessNotice(state)}
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
    description: 'Account access, identity, and security - all in one place.',
    labelId: 'user-settings-title',
    panelClass: 'legacy-auth-panel-user-settings',
    content: `
      <div class="legacy-user-settings-grid">
        ${renderAccountAccessSummaryCard(state)}
        ${renderAccountProfileCard(state)}
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
    ${getVisibleConfigFields(state).map((field) => renderConfigField(state, field)).join('')}
    <div class="config-item config-item-sound">
      <label>Sound alert</label>
      <select name="sound-mode">
        <option value="on">Enabled</option>
        <option value="off">Disabled</option>
      </select>
    </div>
    ${renderBrowserNotificationControl(state)}
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
    <div class="legacy-sound-row">
      <div class="config-item config-item-sound config-item-sound-volume">
        <label>Sound volume: ${Math.round(state.ui.soundVolume * 100)}%</label>
        <input name="sound-volume" class="legacy-volume-slider" type="range" min="0" max="100" step="1" />
      </div>
      ${renderSoundUploadStrip(state)}
    </div>
  `;
}

function getBrowserNotificationStatusLabel(state: AppState) {
  const notificationState = state.ui.browserNotifications;
  if (notificationState.permission === 'unsupported') {
    return 'Not supported';
  }
  if (notificationState.permission === 'denied') {
    return 'Blocked';
  }
  if (notificationState.enabled && notificationState.permission === 'granted') {
    return 'Allowed';
  }
  return 'Off';
}

function renderBrowserNotificationControl(state: AppState) {
  const notificationState = state.ui.browserNotifications;
  const status = getBrowserNotificationStatusLabel(state);
  const canEnable = notificationState.permission === 'default' || notificationState.permission === 'granted';
  const isEnabled = notificationState.enabled && notificationState.permission === 'granted';
  const action = isEnabled ? 'disable-browser-notifications' : 'enable-browser-notifications';
  const buttonText = isEnabled ? 'Enabled' : status;
  const disabled = !isEnabled && !canEnable;

  return `
    <div class="config-item config-item-sound">
      <label>Browser Notifications</label>
      <div class="legacy-browser-notification-control">
        <button type="button" class="old-filter-btn config-menu-button legacy-browser-notification-button ${isEnabled ? 'active' : ''}" data-action="${action}" ${disabled ? 'disabled' : ''}>${escapeHtml(buttonText)}</button>
      </div>
    </div>
  `;
}

function getVisibleConfigFields(state: AppState) {
  return CONFIG_FIELDS.filter((field) => !field.adminOnly || state.session.role === 'admin');
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
      ${state.session.role === 'admin' ? `
        <form class="blocked-token-admin-unblock-form" data-role="admin-unblock-token-form">
          <input
            type="text"
            name="adminBlockedAddress"
            class="legacy-input blocked-token-admin-unblock-input"
            placeholder="Token contract"
            autocomplete="off"
            spellcheck="false"
            ${state.ui.busy ? 'disabled' : ''}
          />
          <button type="submit" class="legacy-user-dd-item blocked-token-admin-unblock-submit" ${state.ui.busy ? 'disabled' : ''}>Unblock Backend</button>
        </form>
      ` : ''}
      <div class="blocked-tokens-modal-list">
        ${state.data.blocklist.length === 0 ? `
          <div class="blocked-token-empty">No blocked tokens right now.</div>
        ` : state.data.blocklist.map((item) => `
          <div class="blocked-token-row">
            <div class="blocked-token-main">
              ${renderBlockedTokenAvatar(state, item, item.label || item.address.slice(0, 8))}
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

function renderBlockedTokenAvatar(state: AppState, item: AppState['data']['blocklist'][number], fallbackLabel: string) {
  const tracked = getTrackedToken(state, item.address);
  const imageUrl = sanitizeOptionalHttpUrl(item.imageUrl || tracked?.imageUrl);
  const safeLabel = escapeHtml(String(fallbackLabel || '').trim() || item.address.slice(0, 8));
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
  const state = controller.state;
  const panel = section.querySelector<HTMLElement>('[data-auth-panel="user-settings"]');
  if (!panel) {
    return;
  }

  bindFocusTrap(panel);
  bindLinkedIdentityActions(section, controller);
  section.querySelector<HTMLButtonElement>('[data-action="focus-billing-plans"]')?.addEventListener('click', () => {
    section.querySelector<HTMLElement>('[data-role="billing-plans-card"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  section.querySelector<HTMLButtonElement>('[data-action="connect-wallet"]')?.addEventListener('click', () => {
    void controller.connectWallet();
  });
  section.querySelector<HTMLFormElement>('[data-role="account-profile-form"]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (state.ui.busy || !(form instanceof HTMLFormElement)) {
      return;
    }
    const data = new FormData(form);
    void controller.updateAccountProfile(
      String(data.get('username') || ''),
      String(data.get('email') || ''),
      String(data.get('password') || ''),
      String(data.get('confirmPassword') || ''),
    );
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-change-password-from-user-settings"]')?.addEventListener('click', () => {
    controller.openAuthPanel('change-password');
  });
  section.querySelector<HTMLButtonElement>('[data-action="add-password-by-email"]')?.addEventListener('click', () => {
    const email = String(state.session.email || '').trim();
    if (email) {
      void controller.requestPasswordReset(email);
    }
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
  configSection.querySelector<HTMLButtonElement>('[data-action="enable-browser-notifications"]')?.addEventListener('click', () => {
    void controller.enableBrowserNotifications();
  });
  configSection.querySelector<HTMLButtonElement>('[data-action="disable-browser-notifications"]')?.addEventListener('click', () => {
    controller.disableBrowserNotifications();
  });

  const volumeInput = configSection.querySelector<HTMLInputElement>('input[name="sound-volume"]');
  const volumeLabel = volumeInput?.closest('.config-item')?.querySelector('label');
  volumeInput?.addEventListener('input', (event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value || '0');
    if (volumeLabel) volumeLabel.textContent = `Sound volume: ${value}%`;
    controller.setSoundVolume(value / 100);
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
  section.querySelector<HTMLFormElement>('form[data-role="admin-unblock-token-form"]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    void controller.adminUnblockToken(String(data.get('adminBlockedAddress') || ''));
  });
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
  const recent6h = Number(state.data.configs['recent-surge-6h-threshold'] ?? 100);
  const oldWeek1h = Number(state.data.configs['old-week-surge-1h-threshold'] ?? 50);
  const oldWeek6h = Number(state.data.configs['old-week-surge-6h-threshold'] ?? 100);
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
  const recent6hThreshold = Number(state.data.configs['recent-surge-6h-threshold'] ?? 100);
  const oldWeek1hThreshold = Number(state.data.configs['old-week-surge-1h-threshold'] ?? 50);
  const oldWeek6hThreshold = Number(state.data.configs['old-week-surge-6h-threshold'] ?? 100);
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
    { slot: 'claim', title: 'GMGN Claim Alert', sub: 'Pump + Bags claim / MP3/WAV/OGG', dot: 'sound-dot claim' },
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
                Choose file
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

function renderConfigField(_state: AppState, field: ConfigField) {
  const type = field.type ?? 'number';
  const safeLabel = escapeHtml(field.label);
  const safeType = escapeHtml(type);
  const safeKey = escapeHtml(field.key);
  const safePlaceholder = field.placeholder ? escapeHtml(field.placeholder) : null;

  return `
    <div class="config-item">
      <label>${safeLabel}</label>
      <input type="${safeType}" name="${safeKey}" ${field.min != null ? `min="${field.min}"` : ''} ${field.step != null ? `step="${field.step}"` : ''} ${safePlaceholder ? `placeholder="${safePlaceholder}"` : ''}>
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

function resolveConfigInputValue(state: AppState, field: ConfigField) {
  const type = field.type ?? 'number';
  const value = state.data.configs[field.key];
  if (value == null || value === '') {
    return String(defaultConfigValue(field.key, type));
  }
  return String(value);
}

function hydrateLegacyConfigValues(section: HTMLElement, state: AppState) {
  for (const field of getVisibleConfigFields(state)) {
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
    ['recent-surge-6h-threshold', 100],
    ['old-week-surge-1h-threshold', 50],
    ['old-week-surge-6h-threshold', 100],
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
    'min-vol': 10000,
    'min-mcap': 30000,
    'max-mcap': 0,
    'hvnc-min-vol': 300000,
    'old-alert-1h-threshold': 50,
    'old-alert-6h-threshold': 100,
    'recent-surge-1h-threshold': 50,
    'recent-surge-6h-threshold': 100,
    'old-week-surge-1h-threshold': 50,
    'old-week-surge-6h-threshold': 100,
    'meteora-alert-1h-threshold': 50,
    'old-mcap-max': 100000000,
    'old-week-mcap-max': 100000000,
  };
  return String(defaults[key] ?? 0);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
