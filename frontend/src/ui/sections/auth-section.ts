import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';
import { renderFlash } from './shared';

export function renderAuthSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'surface-card action-card';
  const isAuthenticated = state.session.status === 'authenticated';
  section.innerHTML = `
    <div class="card-topline"><span class="section-tag">AUTH</span><span class="count-pill">${isAuthenticated ? 'LIVE' : 'LOGIN'}</span></div>
    <h2>Session Flow</h2>
    <p>Token is stored locally, restore uses <code>/api/auth/me</code>, socket auth uses the same token, and logout paths keep the backend session model intact.</p>
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
  return `
    <div class="auth-summary">
      <div class="summary-row"><span>Username</span><strong>${state.session.username ?? '-'}</strong></div>
      <div class="summary-row"><span>Email</span><strong>${state.session.email ?? '-'}</strong></div>
      <div class="summary-row"><span>Role</span><strong>${state.session.role ?? '-'}</strong></div>
      <div class="summary-row"><span>Token</span><strong>${state.session.token ? 'present' : 'missing'}</strong></div>
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
