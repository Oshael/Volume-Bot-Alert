import type { AppState } from '../../state/app-state';

export type AuthFeedbackKind =
  | 'credentials'
  | 'account'
  | 'lockout'
  | 'network'
  | 'session'
  | 'login-required'
  | 'success'
  | 'validation'
  | 'notice'
  | 'error';

export const AUTH_TRANSIENT_NOTICES = new Set([
  'Signing in...',
  'Restoring session...',
  'Creating account...',
  'Login successful. Workspace synced.',
  'Session restored. Workspace synced.',
  'Account created. Workspace synced.',
]);

export function getAuthFeedbackKind(state: Pick<AppState, 'ui'>, message: string): AuthFeedbackKind {
  if (state.ui.error) {
    if (
      message === 'Email is required.'
      || message === 'Enter a valid email address.'
      || message === 'Password is required.'
      || message === 'Password is too long.'
    ) {
      return 'validation';
    }
    if (message.includes('Incorrect email or password')) return 'credentials';
    if (message.includes('deactivated')) return 'account';
    if (message.includes('temporarily locked')) return 'lockout';
    if (message.includes('Unable to reach the server')) return 'network';
    if (message.includes('saved session is no longer valid')) return 'session';
    return 'error';
  }

  if (message.includes('No saved session')) return 'login-required';
  if (message.includes('Session restored')) return 'success';
  if (message.includes('Login successful')) return 'success';
  if (message.includes('Account created')) return 'success';
  if (message.includes('Signing in')) return 'session';
  if (message.includes('Restoring session')) return 'session';
  if (message.includes('Creating account')) return 'session';
  return 'notice';
}

export function getAuthFlashBadge(kind: AuthFeedbackKind) {
  switch (kind) {
    case 'credentials':
      return 'CHECK';
    case 'account':
      return 'ACCOUNT';
    case 'network':
      return 'NETWORK';
    case 'session':
      return 'SESSION';
    case 'login-required':
      return 'LOGIN';
    case 'success':
      return 'OK';
    default:
      return '';
  }
}

export function getAuthSupportCopy(kind: AuthFeedbackKind) {
  switch (kind) {
    case 'lockout':
      return 'Too many attempts were detected. Wait for the lockout window to pass, then contact an administrator if access is still blocked.';
    case 'account':
      return 'This usually requires administrator action. Contact an administrator to restore account access.';
    case 'network':
      return 'Check your connection or API availability first. If the issue persists, contact an administrator.';
    case 'session':
      return 'If your session keeps expiring or getting revoked, contact an administrator to review account access.';
    case 'validation':
      return 'Check the highlighted field above, then try signing in again.';
    default:
      return 'Need access help? Contact an administrator for account or invite support.';
  }
}

export function shouldClearAuthFeedbackOnEdit(error: string | null, notice: string | null) {
  return Boolean(error || (notice && AUTH_TRANSIENT_NOTICES.has(notice)));
}
