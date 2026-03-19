import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';
import { renderFlash } from './shared';
import { escapeHtml } from './html-safety';

export function renderAuthSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'surface-card action-card';
  const isAuthenticated = state.session.status === 'authenticated';
  section.innerHTML = `
    <div class="card-topline"><span class="section-tag">AUTH</span><span class="count-pill">${isAuthenticated ? 'LIVE' : 'LOGIN'}</span></div>
    <h2>Session Flow</h2>
    <p>Session auth uses an HttpOnly cookie, restore uses <code>/api/auth/me</code>, and realtime auth follows the same backend session model.</p>
    ${renderFlash(state)}
    ${isAuthenticated ? renderAuthenticatedBody(state) : renderLoginBody(state)}
  `;

  if (isAuthenticated) {
    section.querySelector<HTMLButtonElement>('[data-action="reload-config"]')?.addEventListener('click', () => void controller.reloadConfig());
    section.querySelector<HTMLButtonElement>('[data-action="logout"]')?.addEventListener('click', () => void controller.logout());
    section.querySelector<HTMLButtonElement>('[data-action="logout-all"]')?.addEventListener('click', () => void controller.logoutAll());
  } else {
    const form = section.querySelector<HTMLFormElement>('form[data-role="login-form"]');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      void controller.login(String(formData.get('email') || '').trim(), String(formData.get('password') || ''));
    });
  }

  section.querySelector<HTMLButtonElement>('[data-action="dismiss-flash"]')?.addEventListener('click', () => controller.clearNotice());
  return section;
}

function renderAuthenticatedBody(state: AppState) {
  const sessionStatus = escapeHtml(state.session.status === 'authenticated' ? 'active' : 'missing');
  return `
    <div class="auth-summary">
      <div class="summary-row"><span>Username</span><strong>${escapeHtml(state.session.username ?? '-')}</strong></div>
      <div class="summary-row"><span>Email</span><strong>${escapeHtml(state.session.email ?? '-')}</strong></div>
      <div class="summary-row"><span>Role</span><strong>${escapeHtml(state.session.role ?? '-')}</strong></div>
      <div class="summary-row"><span>Session</span><strong>${sessionStatus}</strong></div>
    </div>
    <div class="button-row">
      <button type="button" class="action-button" data-action="reload-config">Reload Config</button>
      <button type="button" class="action-button" data-action="logout">Logout</button>
      <button type="button" class="action-button danger" data-action="logout-all">Logout All</button>
    </div>
  `;
}

function renderLoginBody(state: AppState) {
  return `
    <form class="login-form" data-role="login-form">
      <label><span>Email</span><input name="email" type="email" placeholder="testeuser5@example.com" autocomplete="username" required ${state.ui.busy ? 'disabled' : ''} /></label>
      <label><span>Password</span><input name="password" type="password" placeholder="SenhaForte123!" autocomplete="current-password" required ${state.ui.busy ? 'disabled' : ''} /></label>
      <button type="submit" class="action-button primary" ${state.ui.busy ? 'disabled' : ''}>${state.ui.busy ? 'Working...' : 'Login'}</button>
    </form>
  `;
}
