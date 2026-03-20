import { apiFetch } from './base';

export interface SessionUser {
  id: number;
  username: string;
  email: string;
  role: string;
  isActive?: boolean;
  isEmailVerified?: boolean;
  emailVerifiedAt?: string | null;
}

export interface LoginResponse {
  message: string;
  user: SessionUser;
  emailVerificationRequired?: boolean;
  verificationEmailSent?: boolean;
  verificationEmailError?: string | null;
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  inviteCode: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  confirmNewPassword: string;
}

export interface VerifyEmailConfirmResponse {
  message: string;
  user: SessionUser;
}

export interface VerifyEmailRequestInput {
  email: string;
}

export interface PasswordResetRequestInput {
  email: string;
}

export interface PasswordResetConfirmInput {
  token: string;
  newPassword: string;
  confirmNewPassword: string;
}

export function fetchCurrentSession(token?: string | null) {
  return apiFetch<{ user: SessionUser }>('/api/auth/me', { token });
}

export function login(email: string, password: string) {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    token: null,
  });
}

export function register(input: RegisterInput) {
  return apiFetch<LoginResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
    token: null,
  });
}

export function changePassword(input: ChangePasswordInput, token?: string | null) {
  return apiFetch<{ message: string }>('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify(input),
    token,
  });
}

export function logout(token?: string | null) {
  return apiFetch<{ message: string }>('/api/auth/logout', {
    method: 'POST',
    token,
  });
}

export function logoutAll(token?: string | null) {
  return apiFetch<{ message: string }>('/api/auth/logout-all', {
    method: 'POST',
    token,
  });
}

export function requestEmailVerification(input: VerifyEmailRequestInput, token?: string | null) {
  return apiFetch<{ message: string; alreadyVerified: boolean }>('/api/auth/verify-email/request', {
    method: 'POST',
    body: JSON.stringify(input),
    token,
  });
}

export function confirmEmailVerification(tokenValue: string) {
  return apiFetch<VerifyEmailConfirmResponse>('/api/auth/verify-email/confirm', {
    method: 'POST',
    body: JSON.stringify({ token: tokenValue }),
    token: null,
  });
}

export function requestPasswordReset(input: PasswordResetRequestInput) {
  return apiFetch<{ message: string }>('/api/auth/password-reset/request', {
    method: 'POST',
    body: JSON.stringify(input),
    token: null,
  });
}

export function confirmPasswordReset(input: PasswordResetConfirmInput) {
  return apiFetch<{ message: string }>('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: JSON.stringify(input),
    token: null,
  });
}
