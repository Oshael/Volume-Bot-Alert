import type { AppController } from '../state/app-controller';
import type { AppState } from '../state/app-state';
import { renderAlertsSection } from './sections/alerts-section';
import { renderBlocklistSection } from './sections/blocklist-section';
import { renderLegacyShell } from './sections/layout-sections';
import { renderManualTokensSection } from './sections/manual-section';
import { renderMonitoredSection } from './sections/monitored-section';
import { renderPumpfunSection } from './sections/pumpfun-section';
import { renderPumpToasts } from './sections/pumpfun-toasts';
import { renderOldWeekSection, renderRecentSection } from './sections/routed-sections';

type ConfigDraft = {
  values: Record<string, string>;
  focusedName: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
};

type PanelScrollDraft = {
  monitored: number;
  pumpfun: number;
  alerts: number;
};

type LoginDraft = {
  email: string;
  password: string;
  passwordVisible: boolean;
};

type ChangePasswordDraft = {
  currentPassword: string;
  newPassword: string;
  currentVisible: boolean;
  newVisible: boolean;
};

type RegisterDraft = {
  username: string;
  email: string;
  password: string;
  inviteCode: string;
  passwordVisible: boolean;
};

type InviteAssistanceDraft = {
  inviteCode: string;
};

export function renderAppShell(root: HTMLElement, state: AppState, controller: AppController) {
  const configDraft = captureConfigDraft(root);
  const panelScrollDraft = capturePanelScrollDraft(root);
  const loginDraft = captureLoginDraft(root);
  const changePasswordDraft = captureChangePasswordDraft(root);
  const registerDraft = captureRegisterDraft(root);
  const inviteAssistanceDraft = captureInviteAssistanceDraft(root);
  root.innerHTML = '';

  const shell = document.createElement('div');
  shell.className = 'app-shell';
  shell.append(renderPumpToasts(state), renderLegacyShell(state, controller));

  if (state.session.status === 'authenticated') {
    if (state.data.blocklist.length > 0) {
      shell.append(renderBlocklistSection(state, controller));
    }
    shell.append(
      renderOldWeekSection(state, controller),
      renderRecentSection(state, controller),
      renderManualTokensSection(state, controller),
    );

    const panels = document.createElement('div');
    panels.className = 'legacy-panels';
    panels.append(
      renderMonitoredSection(state, controller),
      renderPumpfunSection(state, controller),
      renderAlertsSection(state, controller),
    );
    shell.append(panels);
  }

  root.append(shell);
  applyLoginDraft(root, loginDraft, state);
  applyLoginFocus(root, state);
  applyChangePasswordDraft(root, changePasswordDraft);
  applyChangePasswordFocus(root, state);
  applyRegisterDraft(root, registerDraft);
  applyRegisterFocus(root, state);
  applyInviteAssistanceDraft(root, inviteAssistanceDraft);
  applyInviteAssistanceFocus(root, state);
  applyConfigDraft(root, configDraft, state);
  applyPanelScrollDraft(root, panelScrollDraft);
  wireHoverPersistence(root);
  wireTradeMenus(root);
  wireSortMenus(root);
  wireLogHovers(root);
  wireUserMenus(root);
  applyHoverState(root);
}




let currentHoverKey: string | null = null;
let hoverWired = false;
let tradeWired = false;
let sortMenusWired = false;
let userMenusWired = false;
let logHoverWired = false;

function wireHoverPersistence(root: HTMLElement) {
  if (hoverWired) return;
  hoverWired = true;

  root.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[data-hover-key]');
    currentHoverKey = row?.dataset.hoverKey ?? null;
    applyHoverState(root);
  });

  root.addEventListener('mouseout', (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[data-hover-key]');
    if (!row) return;

    const related = event.relatedTarget as HTMLElement | null;
    if (related && row.contains(related)) return;

    if (currentHoverKey === row.dataset.hoverKey) {
      currentHoverKey = null;
      applyHoverState(root);
    }
  });
}

function applyHoverState(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('.forced-hover')) {
    el.classList.remove('forced-hover');
  }
  if (!currentHoverKey) return;
  const hovered = root.querySelector<HTMLElement>(`[data-hover-key="${currentHoverKey}"]`);
  if (hovered) hovered.classList.add('forced-hover');
}

function wireTradeMenus(root: HTMLElement) {
  if (tradeWired) return;
  tradeWired = true;

  root.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement | null;
    const wrap = target?.closest<HTMLElement>('[data-trade-wrap]');
    if (!wrap) return;

    const menu = wrap.querySelector<HTMLElement>('[data-trade-menu]');
    if (!menu) return;

    menu.classList.remove('open-up', 'open-down', 'open-left', 'open-right');
    const rect = wrap.getBoundingClientRect();
    const boundary = wrap.closest<HTMLElement>('.token-table-wrap, .monitored-list, .pump-list, .alerts-list, .panel, .legacy-panel');
    const boundaryRect = boundary?.getBoundingClientRect();
    const estimatedHeight = Math.max(menu.offsetHeight || 0, 118);
    const estimatedWidth = Math.max(menu.offsetWidth || 0, 90);
    const availableBottom = boundaryRect ? boundaryRect.bottom - rect.bottom : window.innerHeight - rect.bottom;
    const availableTop = boundaryRect ? rect.top - boundaryRect.top : rect.top;
    const availableRight = boundaryRect ? boundaryRect.right - rect.right : window.innerWidth - rect.right;
    const availableLeft = boundaryRect ? rect.left - boundaryRect.left : rect.left;
    const shouldOpenUp = availableBottom < estimatedHeight + 12 && availableTop > availableBottom;
    const shouldOpenLeft = availableRight < estimatedWidth + 16 && availableLeft > availableRight;

    menu.classList.add(shouldOpenUp ? 'open-up' : 'open-down');
    menu.classList.add(shouldOpenLeft ? 'open-left' : 'open-right');
  });
}

function wireSortMenus(root: HTMLElement) {
  if (sortMenusWired) return;
  sortMenusWired = true;

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest<HTMLElement>('[data-sort-toggle]');
    const wrap = target?.closest<HTMLElement>('[data-sort-wrap]');

    for (const openWrap of root.querySelectorAll<HTMLElement>('[data-sort-wrap].open')) {
      if (openWrap !== wrap) openWrap.classList.remove('open');
    }

    if (toggle && wrap) {
      event.preventDefault();
      wrap.classList.toggle('open');
      return;
    }

    if (!wrap) {
      for (const openWrap of root.querySelectorAll<HTMLElement>('[data-sort-wrap].open')) {
        openWrap.classList.remove('open');
      }
    }
  });
}

function wireLogHovers(root: HTMLElement) {
  if (logHoverWired) return;
  logHoverWired = true;

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest<HTMLElement>('[data-log-hover-toggle]');
    const wrap = target?.closest<HTMLElement>('[data-log-hover]');

    for (const openWrap of root.querySelectorAll<HTMLElement>('[data-log-hover].open')) {
      if (openWrap !== wrap) openWrap.classList.remove('open');
    }

    if (toggle && wrap) {
      event.preventDefault();
      wrap.classList.toggle('open');
      return;
    }

    if (!wrap) {
      for (const openWrap of root.querySelectorAll<HTMLElement>('[data-log-hover].open')) {
        openWrap.classList.remove('open');
      }
    }
  });
}

function wireUserMenus(root: HTMLElement) {
  if (userMenusWired) return;
  userMenusWired = true;

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest<HTMLElement>('[data-action="toggle-user-menu"]');
    const menu = target?.closest<HTMLElement>('[data-user-menu]');

    for (const openMenu of root.querySelectorAll<HTMLElement>('[data-user-menu].open')) {
      if (openMenu !== menu) openMenu.classList.remove('open');
    }

    if (toggle && menu) {
      event.preventDefault();
      menu.classList.toggle('open');
      return;
    }

    if (!menu) {
      for (const openMenu of root.querySelectorAll<HTMLElement>('[data-user-menu].open')) {
        openMenu.classList.remove('open');
      }
    }
  });
}

function capturePanelScrollDraft(root: HTMLElement): PanelScrollDraft {
  return {
    monitored: root.querySelector<HTMLElement>('.monitored-list')?.scrollTop ?? 0,
    pumpfun: root.querySelector<HTMLElement>('.pump-list')?.scrollTop ?? 0,
    alerts: root.querySelector<HTMLElement>('.alerts-list')?.scrollTop ?? 0,
  };
}

function applyPanelScrollDraft(root: HTMLElement, draft: PanelScrollDraft) {
  const monitored = root.querySelector<HTMLElement>('.monitored-list');
  const pumpfun = root.querySelector<HTMLElement>('.pump-list');
  const alerts = root.querySelector<HTMLElement>('.alerts-list');

  if (monitored) monitored.scrollTop = draft.monitored;
  if (pumpfun) pumpfun.scrollTop = draft.pumpfun;
  if (alerts) alerts.scrollTop = draft.alerts;
}

function captureLoginDraft(root: HTMLElement): LoginDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="login-form"]');
  if (!form) {
    return null;
  }

  const email = form.querySelector<HTMLInputElement>('input[name="email"]');
  const password = form.querySelector<HTMLInputElement>('input[name="password"]');

  return {
    email: email?.value ?? '',
    password: password?.value ?? '',
    passwordVisible: password?.type === 'text',
  };
}

function applyLoginDraft(root: HTMLElement, draft: LoginDraft | null, state: AppState) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="login-form"]');
  if (!form) {
    return;
  }

  const email = form.querySelector<HTMLInputElement>('input[name="email"]');
  const password = form.querySelector<HTMLInputElement>('input[name="password"]');
  const toggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-password-visibility"]');

  if (email && draft?.email) {
    email.value = draft.email;
  }
  if (password && draft?.password) {
    password.value = draft.password;
  }
  if (password && draft?.passwordVisible) {
    password.type = 'text';
  }

  if (toggle && password) {
    toggle.textContent = password.type === 'text' ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', password.type === 'text' ? 'Hide password' : 'Show password');
  }
}

function applyLoginFocus(root: HTMLElement, state: AppState) {
  if (state.session.status === 'authenticated' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="login-form"]');
  if (!form) {
    return;
  }

  const emailInput = form.querySelector<HTMLInputElement>('input[name="email"]');
  const passwordInput = form.querySelector<HTMLInputElement>('input[name="password"]');

  if (!state.ui.error) {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !form.contains(active)) {
      emailInput?.focus();
    }
    return;
  }

  if (state.ui.error === 'Email is required.' || state.ui.error === 'Enter a valid email address.') {
    emailInput?.focus();
    emailInput?.select();
    return;
  }

  if (
    state.ui.error.includes('Incorrect email or password')
  ) {
    emailInput?.focus();
    emailInput?.select();
    return;
  }

  if (
    state.ui.error === 'Password is required.'
  ) {
    passwordInput?.focus();
    passwordInput?.select();
  }
}

function captureChangePasswordDraft(root: HTMLElement): ChangePasswordDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="change-password-form"]');
  if (!form) {
    return null;
  }

  const currentPassword = form.querySelector<HTMLInputElement>('input[name="currentPassword"]');
  const newPassword = form.querySelector<HTMLInputElement>('input[name="newPassword"]');

  return {
    currentPassword: currentPassword?.value ?? '',
    newPassword: newPassword?.value ?? '',
    currentVisible: currentPassword?.type === 'text',
    newVisible: newPassword?.type === 'text',
  };
}

function applyChangePasswordDraft(root: HTMLElement, draft: ChangePasswordDraft | null) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="change-password-form"]');
  if (!form || !draft) {
    return;
  }

  const currentPassword = form.querySelector<HTMLInputElement>('input[name="currentPassword"]');
  const newPassword = form.querySelector<HTMLInputElement>('input[name="newPassword"]');
  const currentToggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-current-password-visibility"]');
  const newToggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-new-password-visibility"]');

  if (currentPassword) {
    currentPassword.value = draft.currentPassword;
    if (draft.currentVisible) {
      currentPassword.type = 'text';
    }
  }
  if (newPassword) {
    newPassword.value = draft.newPassword;
    if (draft.newVisible) {
      newPassword.type = 'text';
    }
  }

  if (currentToggle && currentPassword) {
    currentToggle.textContent = currentPassword.type === 'text' ? 'Hide' : 'Show';
  }
  if (newToggle && newPassword) {
    newToggle.textContent = newPassword.type === 'text' ? 'Hide' : 'Show';
  }
}

function applyChangePasswordFocus(root: HTMLElement, state: AppState) {
  if (state.ui.authPanel !== 'change-password' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="change-password-form"]');
  const currentPassword = form?.querySelector<HTMLInputElement>('input[name="currentPassword"]');
  const newPassword = form?.querySelector<HTMLInputElement>('input[name="newPassword"]');
  const active = document.activeElement;

  if (active instanceof HTMLElement && form?.contains(active)) {
    return;
  }

  if (state.ui.error === 'Current password is required.') {
    currentPassword?.focus();
    return;
  }
  if (
    state.ui.error === 'New password is required.'
    || state.ui.error === 'New password must be at least 8 characters.'
    || state.ui.error === 'New password must be different from the current password.'
  ) {
    newPassword?.focus();
    return;
  }

  currentPassword?.focus();
}

function captureRegisterDraft(root: HTMLElement): RegisterDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="register-form"]');
  if (!form) {
    return null;
  }

  const username = form.querySelector<HTMLInputElement>('input[name="username"]');
  const email = form.querySelector<HTMLInputElement>('input[name="registerEmail"]');
  const password = form.querySelector<HTMLInputElement>('input[name="registerPassword"]');
  const inviteCode = form.querySelector<HTMLInputElement>('input[name="inviteCode"]');

  return {
    username: username?.value ?? '',
    email: email?.value ?? '',
    password: password?.value ?? '',
    inviteCode: inviteCode?.value ?? '',
    passwordVisible: password?.type === 'text',
  };
}

function applyRegisterDraft(root: HTMLElement, draft: RegisterDraft | null) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="register-form"]');
  if (!form || !draft) {
    return;
  }

  const username = form.querySelector<HTMLInputElement>('input[name="username"]');
  const email = form.querySelector<HTMLInputElement>('input[name="registerEmail"]');
  const password = form.querySelector<HTMLInputElement>('input[name="registerPassword"]');
  const inviteCode = form.querySelector<HTMLInputElement>('input[name="inviteCode"]');
  const toggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-register-password-visibility"]');

  if (username) username.value = draft.username;
  if (email) email.value = draft.email;
  if (inviteCode) inviteCode.value = draft.inviteCode;
  if (password) {
    password.value = draft.password;
    if (draft.passwordVisible) {
      password.type = 'text';
    }
  }

  if (toggle && password) {
    toggle.textContent = password.type === 'text' ? 'Hide' : 'Show';
  }
}

function applyRegisterFocus(root: HTMLElement, state: AppState) {
  if (state.ui.authPanel !== 'register' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="register-form"]');
  const username = form?.querySelector<HTMLInputElement>('input[name="username"]');
  const email = form?.querySelector<HTMLInputElement>('input[name="registerEmail"]');
  const password = form?.querySelector<HTMLInputElement>('input[name="registerPassword"]');
  const inviteCode = form?.querySelector<HTMLInputElement>('input[name="inviteCode"]');
  const active = document.activeElement;
  const focusAndSelect = (input: HTMLInputElement | null | undefined) => {
    if (!input) {
      return;
    }
    input.focus();
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  };

  if (active instanceof HTMLElement && form?.contains(active)) {
    return;
  }

  if (
    state.ui.error === 'Username is required.'
    || state.ui.error === 'Username must be at least 3 characters.'
    || state.ui.error === 'Username must be 3-32 characters and use only letters, numbers, or underscores.'
    || state.ui.error === 'Username already taken'
  ) {
    focusAndSelect(username);
    return;
  }
  if (
    state.ui.error === 'Email is required.'
    || state.ui.error === 'Enter a valid email address.'
    || state.ui.error === 'Email already registered'
    || state.ui.error === 'Invalid email format'
  ) {
    focusAndSelect(email);
    return;
  }
  if (
    state.ui.error === 'Password is required.'
    || state.ui.error === 'Password must be at least 8 characters.'
    || state.ui.error === 'Password must be 8-128 characters.'
  ) {
    focusAndSelect(password);
    return;
  }
  if (
    state.ui.error === 'Invite code is required.'
    || state.ui.error?.includes('Invite')
    || state.ui.error?.includes('invite')
  ) {
    focusAndSelect(inviteCode);
    return;
  }

  username?.focus();
}

function captureInviteAssistanceDraft(root: HTMLElement): InviteAssistanceDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="invite-assistance-form"]');
  if (!form) {
    return null;
  }

  const email = form.querySelector<HTMLInputElement>('input[name="assistanceEmail"]');
  const inviteCode = form.querySelector<HTMLInputElement>('input[name="assistanceInviteCode"]');

  return {
    inviteCode: inviteCode?.value ?? '',
  };
}

function applyInviteAssistanceDraft(root: HTMLElement, draft: InviteAssistanceDraft | null) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="invite-assistance-form"]');
  if (!form || !draft) {
    return;
  }

  const inviteCode = form.querySelector<HTMLInputElement>('input[name="assistanceInviteCode"]');

  if (inviteCode) inviteCode.value = draft.inviteCode;
}

function applyInviteAssistanceFocus(root: HTMLElement, state: AppState) {
  if (state.ui.authPanel !== 'invite-assistance' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="invite-assistance-form"]');
  const inviteCode = form?.querySelector<HTMLInputElement>('input[name="assistanceInviteCode"]');
  const active = document.activeElement;

  if (active instanceof HTMLElement && form?.contains(active)) {
    return;
  }

  inviteCode?.focus();
}

function captureConfigDraft(root: HTMLElement): ConfigDraft | null {
  const configSection = root.querySelector('.legacy-config-grid');
  if (!configSection) {
    return null;
  }

  const values: Record<string, string> = {};
  for (const field of configSection.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
    values[field.name] = field.value;
  }

  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLSelectElement) || !configSection.contains(active) || !active.name) {
    return { values, focusedName: null, selectionStart: null, selectionEnd: null };
  }

  return {
    values,
    focusedName: active.name,
    selectionStart: active instanceof HTMLInputElement ? active.selectionStart : null,
    selectionEnd: active instanceof HTMLInputElement ? active.selectionEnd : null,
  };
}

function applyConfigDraft(root: HTMLElement, draft: ConfigDraft | null, state: AppState) {
  if (!draft) return;

  const configSection = root.querySelector('.legacy-config-grid');
  if (!configSection) return;

  if (!draft.focusedName && state.ui.busy) {
    for (const field of configSection.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
      const value = draft.values[field.name];
      if (value != null) {
        field.value = value;
      }
    }
    return;
  }

  if (!draft.focusedName) return;
  const focused = configSection.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${draft.focusedName}"]`);
  if (!focused) return;

  const value = draft.values[draft.focusedName];
  if (value != null) {
    focused.value = value;
  }

  focused.focus();
  if (focused instanceof HTMLInputElement && draft.selectionStart != null && draft.selectionEnd != null) {
    focused.setSelectionRange(draft.selectionStart, draft.selectionEnd);
  }
}
