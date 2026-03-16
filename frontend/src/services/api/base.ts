import { getAuthToken } from '../../utils/auth-storage';

const PROD_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '')
  || 'https://volume-alert-server-production.up.railway.app';

export function resolveApiBase(locationLike: Location = window.location): string {
  const params = new URLSearchParams(locationLike.search);
  const override = params.get('api');
  if (override) {
    return override.replace(/\/+$/, '');
  }

  const host = locationLike.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (isLocal) {
    return 'http://localhost:3000';
  }

  if (host.endsWith('.vercel.app')) {
    return PROD_API_BASE;
  }

  return locationLike.origin.replace(/\/+$/, '');
}

export interface ApiFetchOptions extends RequestInit {
  token?: string | null;
}

export async function apiFetch<T>(path: string, init?: ApiFetchOptions): Promise<T> {
  const token = init?.token ?? getAuthToken();
  const headers = new Headers(init?.headers || {});

  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${resolveApiBase()}${path}`, {
    ...init,
    cache: 'no-store',
    credentials: 'include',
    headers,
  });

  if (!response.ok) {
    let message = `API request failed: ${response.status}`;
    try {
      const body = await response.json() as { error?: string };
      if (body?.error) {
        message = body.error;
      }
    } catch (_) {
      // Keep fallback message.
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}
