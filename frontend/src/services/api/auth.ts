import { apiFetch } from './base';

export interface SessionUser {
  id: number;
  username: string;
  email: string;
  role: string;
  is_active?: boolean;
}

export interface LoginResponse {
  message: string;
  token: string;
  user: SessionUser;
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  inviteCode: string;
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
