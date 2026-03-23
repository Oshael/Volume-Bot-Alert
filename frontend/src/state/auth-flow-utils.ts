import type { ChangePasswordInput, LoginOtpVerifyInput, PasswordResetConfirmInput, PasswordResetRequestInput, RegisterInput } from '../services/api/auth';
import { clampLoginPasswordValue, isValidLoginEmail, trimLoginEmailValue } from '../ui/sections/login-form-utils';

const HEX_TOKEN_PATTERN = /^[a-f0-9]+$/i;

function normalizeHexToken(value: string, minLength: number, maxLength: number) {
  const token = String(value || '').trim();
  if (!token || token.length < minLength || token.length > maxLength) {
    return '';
  }
  if (!HEX_TOKEN_PATTERN.test(token)) {
    return '';
  }
  return token.toLowerCase();
}

export function normalizeAuthRouteToken(value: string) {
  return normalizeHexToken(value, 32, 128);
}

export function normalizePasswordResetToken(value: string) {
  return normalizeHexToken(value, 32, 128);
}

export function normalizeLoginOtpChallengeToken(value: string) {
  return normalizeHexToken(value, 32, 96);
}

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
  const confirmPassword = clampLoginPasswordValue(input.confirmPassword || '');
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
  if (!confirmPassword) {
    return { ok: false as const, message: 'Please confirm your password.' };
  }
  if (password !== confirmPassword) {
    return { ok: false as const, message: 'The passwords do not match. Please check them and try again.' };
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
      confirmPassword,
      inviteCode,
    },
  };
}

export function validateChangePasswordInput(input: ChangePasswordInput) {
  const currentPassword = String(input.currentPassword || '');
  const newPassword = clampLoginPasswordValue(input.newPassword || '');
  const confirmNewPassword = clampLoginPasswordValue(input.confirmNewPassword || '');

  if (!currentPassword) {
    return { ok: false as const, message: 'Current password is required.' };
  }
  if (!newPassword) {
    return { ok: false as const, message: 'New password is required.' };
  }
  if (newPassword.length < 8) {
    return { ok: false as const, message: 'New password must be at least 8 characters.' };
  }
  if (!confirmNewPassword) {
    return { ok: false as const, message: 'Please confirm the new password.' };
  }
  if (newPassword !== confirmNewPassword) {
    return { ok: false as const, message: 'The new passwords do not match. Please check them and try again.' };
  }
  if (currentPassword === newPassword) {
    return { ok: false as const, message: 'New password must be different from the current password.' };
  }

  return {
    ok: true as const,
    input: {
      currentPassword,
      newPassword,
      confirmNewPassword,
    },
  };
}

export function validatePasswordResetRequestInput(input: PasswordResetRequestInput) {
  const email = trimLoginEmailValue(input.email || '');

  if (!email) {
    return { ok: false as const, message: 'Email is required.' };
  }
  if (!isValidLoginEmail(email)) {
    return { ok: false as const, message: 'Enter a valid email address.' };
  }

  return {
    ok: true as const,
    input: { email },
  };
}

export function validatePasswordResetConfirmInput(input: PasswordResetConfirmInput) {
  const token = normalizePasswordResetToken(input.token || '');
  const newPassword = clampLoginPasswordValue(input.newPassword || '');
  const confirmNewPassword = clampLoginPasswordValue(input.confirmNewPassword || '');

  if (!token) {
    return { ok: false as const, message: 'Reset link is missing or invalid.' };
  }
  if (!newPassword) {
    return { ok: false as const, message: 'New password is required.' };
  }
  if (newPassword.length < 8) {
    return { ok: false as const, message: 'New password must be at least 8 characters.' };
  }
  if (newPassword.length > 128) {
    return { ok: false as const, message: 'New password must be 8-128 characters.' };
  }
  if (!confirmNewPassword) {
    return { ok: false as const, message: 'Please confirm the new password.' };
  }
  if (newPassword !== confirmNewPassword) {
    return { ok: false as const, message: 'The new passwords do not match. Please check them and try again.' };
  }

  return {
    ok: true as const,
    input: { token, newPassword, confirmNewPassword },
  };
}

export function normalizeInviteCode(input: string) {
  return String(input || '').trim();
}

export function validateLoginOtpInput(input: LoginOtpVerifyInput) {
  const challengeToken = normalizeLoginOtpChallengeToken(input.challengeToken || '');
  const code = String(input.code || '').replace(/\s+/g, '');

  if (!challengeToken) {
    return { ok: false as const, message: 'Verification challenge is missing. Please sign in again.' };
  }
  if (!code) {
    return { ok: false as const, message: 'Verification code is required.' };
  }
  if (!/^\d{6}$/.test(code)) {
    return { ok: false as const, message: 'Enter the 6-digit verification code.' };
  }

  return {
    ok: true as const,
    input: {
      challengeToken,
      code,
    },
  };
}
