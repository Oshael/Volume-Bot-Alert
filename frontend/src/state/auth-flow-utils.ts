import type { ChangePasswordInput, RegisterInput } from '../services/api/auth';
import { clampLoginPasswordValue, isValidLoginEmail, trimLoginEmailValue } from '../ui/sections/login-form-utils';

export function validateLoginCredentials(email: string, password: string) {
  const normalizedEmail = trimLoginEmailValue(email);
  const normalizedPassword = clampLoginPasswordValue(password);

  if (!normalizedEmail) {
    return { ok: false as const, message: 'Email is required.' };
  }

  if (!isValidLoginEmail(normalizedEmail)) {
    return { ok: false as const, message: 'Enter a valid email address.' };
  }

  if (!normalizedPassword) {
    return { ok: false as const, message: 'Password is required.' };
  }

  return {
    ok: true as const,
    email: normalizedEmail,
    password: normalizedPassword,
  };
}

export function validateRegisterInput(input: RegisterInput) {
  const username = String(input.username || '').trim();
  const email = trimLoginEmailValue(input.email || '');
  const password = clampLoginPasswordValue(input.password || '');
  const inviteCode = String(input.inviteCode || '').trim();

  if (!username) {
    return { ok: false as const, message: 'Username is required.' };
  }
  if (username.length < 3) {
    return { ok: false as const, message: 'Username must be at least 3 characters.' };
  }
  if (username.length > 32 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return { ok: false as const, message: 'Username must be 3-32 characters and use only letters, numbers, or underscores.' };
  }
  if (!email) {
    return { ok: false as const, message: 'Email is required.' };
  }
  if (!isValidLoginEmail(email)) {
    return { ok: false as const, message: 'Enter a valid email address.' };
  }
  if (!password) {
    return { ok: false as const, message: 'Password is required.' };
  }
  if (password.length < 8) {
    return { ok: false as const, message: 'Password must be at least 8 characters.' };
  }
  if (password.length > 128) {
    return { ok: false as const, message: 'Password must be 8-128 characters.' };
  }
  if (!inviteCode) {
    return { ok: false as const, message: 'Invite code is required.' };
  }

  return {
    ok: true as const,
    input: {
      username,
      email,
      password,
      inviteCode,
    },
  };
}

export function validateChangePasswordInput(input: ChangePasswordInput) {
  const currentPassword = String(input.currentPassword || '');
  const newPassword = clampLoginPasswordValue(input.newPassword || '');

  if (!currentPassword) {
    return { ok: false as const, message: 'Current password is required.' };
  }
  if (!newPassword) {
    return { ok: false as const, message: 'New password is required.' };
  }
  if (newPassword.length < 8) {
    return { ok: false as const, message: 'New password must be at least 8 characters.' };
  }
  if (currentPassword === newPassword) {
    return { ok: false as const, message: 'New password must be different from the current password.' };
  }

  return {
    ok: true as const,
    input: {
      currentPassword,
      newPassword,
    },
  };
}

export function normalizeInviteCode(input: string) {
  return String(input || '').trim();
}
