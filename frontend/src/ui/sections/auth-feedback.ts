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
  'Sending verification email...',
  'Sending password reset email...',
  'Resetting password...',
  'Verifying email...',
  'Login successful. Workspace synced.',
  'Session restored. Workspace synced.',
  'Account created. Workspace synced.',
]);

const AUTH_VALIDATION_MESSAGES = new Set([
  'Email is required.',
  'Enter a valid email address.',
  'Password is required.',
  'Password is too long.',
  'Reset link is missing or invalid.',
  'New password is required.',
  'New password must be at least 8 characters.',
  'New password must be 8-128 characters.',
]);

const AUTH_ERROR_KINDS: ReadonlyArray<readonly [string, AuthFeedbackKind]> = [
  ['Incorrect email or password', 'credentials'],
  ['deactivated', 'account'],
  ['access has expired', 'account'],
  ['access was revoked', 'account'],
  ['does not currently have product access', 'account'],
  ['not verified', 'account'],
  ['temporarily locked', 'lockout'],
  ['Unable to reach the server', 'network'],
  ['saved session is no longer valid', 'session'],
];

const AUTH_NOTICE_KINDS: ReadonlyArray<readonly [string, AuthFeedbackKind]> = [
  ['No saved session', 'login-required'],
  ['Session restored', 'success'],
  ['Login successful', 'success'],
  ['Account created', 'success'],
  ['Signing in', 'session'],
  ['Restoring session', 'session'],
  ['Creating account', 'session'],
];

function findAuthFeedbackKind(
  message: string,
  rules: ReadonlyArray<readonly [string, AuthFeedbackKind]>,
  fallback: AuthFeedbackKind,
) {
  return rules.find(([fragment]) => message.includes(fragment))?.[1] || fallback;
}

export function getAuthFeedbackKind(state: Pick<AppState, 'ui'>, message: string): AuthFeedbackKind {
  if (state.ui.error) {
    if (AUTH_VALIDATION_MESSAGES.has(message)) {
      return 'validation';
    }
    return findAuthFeedbackKind(message, AUTH_ERROR_KINDS, 'error');
  }

  return findAuthFeedbackKind(message, AUTH_NOTICE_KINDS, 'notice');
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
      return 'Need help? Contact an administrator for general support.';
  }
}

export function shouldClearAuthFeedbackOnEdit(error: string | null, notice: string | null) {
  return Boolean(error || (notice && AUTH_TRANSIENT_NOTICES.has(notice)));
}
