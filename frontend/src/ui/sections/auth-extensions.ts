import type { AppState } from '../../state/app-state';
import type { AuthFeedbackKind } from './auth-feedback';

export type AuthExtensionKey =
  | 'register'
  | 'password-reset'
  | 'invite-assistance'
  | 'two-factor';

export interface AuthExtensionFieldDefinition {
  name: string;
  type: 'text' | 'email' | 'password';
  label: string;
  autocomplete?: string;
  required?: boolean;
  inputMode?: 'email' | 'text';
}

export interface AuthExtensionDefinition {
  key: AuthExtensionKey;
  label: string;
  description: string;
  enabled: boolean;
  backendReady: boolean;
  uiReady: boolean;
  route?: string | null;
  priority: number;
}

const AUTH_EXTENSION_DEFINITIONS: AuthExtensionDefinition[] = [
  {
    key: 'register',
    label: 'Create account',
    description: 'Reserved slot for a future invite-based registration flow.',
    enabled: false,
    backendReady: true,
    uiReady: false,
    route: '/api/auth/register',
    priority: 5,
  },
  {
    key: 'password-reset',
    label: 'Password reset',
    description: 'Reserved slot for password reset or password change account recovery.',
    enabled: false,
    backendReady: true,
    uiReady: false,
    route: '/api/auth/change-password',
    priority: 10,
  },
  {
    key: 'invite-assistance',
    label: 'Invite assistance',
    description: 'Reserved slot for invite validation and account assistance actions.',
    enabled: false,
    backendReady: true,
    uiReady: false,
    route: '/api/invites/validate/:code',
    priority: 20,
  },
  {
    key: 'two-factor',
    label: 'Two-factor authentication',
    description: 'Reserved slot for secondary verification or authenticator setup.',
    enabled: false,
    backendReady: false,
    uiReady: false,
    route: null,
    priority: 30,
  },
];

const AUTH_EXTENSION_FIELDS: Record<AuthExtensionKey, AuthExtensionFieldDefinition[]> = {
  register: [
    { name: 'username', type: 'text', label: 'Username', autocomplete: 'username', required: true },
    { name: 'email', type: 'email', label: 'Email', autocomplete: 'email', required: true, inputMode: 'email' },
    { name: 'password', type: 'password', label: 'Password', autocomplete: 'new-password', required: true },
    { name: 'inviteCode', type: 'text', label: 'Invite code', autocomplete: 'one-time-code', required: true },
  ],
  'password-reset': [
    { name: 'currentPassword', type: 'password', label: 'Current password', autocomplete: 'current-password', required: true },
    { name: 'newPassword', type: 'password', label: 'New password', autocomplete: 'new-password', required: true },
  ],
  'invite-assistance': [
    { name: 'inviteCode', type: 'text', label: 'Invite code', autocomplete: 'one-time-code', required: true },
    { name: 'email', type: 'email', label: 'Email', autocomplete: 'email', required: false, inputMode: 'email' },
  ],
  'two-factor': [
    { name: 'otp', type: 'text', label: 'Authentication code', autocomplete: 'one-time-code', required: true },
  ],
};

export function getAuthExtensionDefinitions() {
  return [...AUTH_EXTENSION_DEFINITIONS].sort((a, b) => a.priority - b.priority);
}

export function getEnabledAuthExtensions() {
  return getAuthExtensionDefinitions().filter((item) => item.enabled);
}

export function getAuthExtensionFields(key: AuthExtensionKey) {
  return [...(AUTH_EXTENSION_FIELDS[key] || [])];
}

export function getBackendReadyAuthExtensions() {
  return getAuthExtensionDefinitions().filter((item) => item.backendReady);
}

export function getAuthExtensionCounts() {
  const defs = getAuthExtensionDefinitions();
  return {
    total: defs.length,
    enabled: defs.filter((item) => item.enabled).length,
    backendReady: defs.filter((item) => item.backendReady).length,
    uiReady: defs.filter((item) => item.uiReady).length,
  };
}

export function getAuthSupportHeading(kind: AuthFeedbackKind | 'idle') {
  switch (kind) {
    case 'lockout':
      return 'Access window';
    case 'account':
      return 'Account access';
    case 'network':
      return 'Connection check';
    case 'session':
      return 'Session help';
    case 'validation':
      return 'Form check';
    case 'credentials':
      return 'Access help';
    default:
      return 'Support';
  }
}

export function getAuthSurfaceMode(state: Pick<AppState, 'ui' | 'session'>) {
  if (state.ui.busy && state.session.status === 'loading') {
    return 'restoring';
  }
  if (state.ui.busy) {
    return 'submitting';
  }
  if (state.ui.error) {
    return 'error';
  }
  if (state.ui.notice) {
    return 'notice';
  }
  return 'idle';
}
