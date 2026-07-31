import { apiFetch } from './base';

export type TelegramConnectionStatus = 'disconnected' | 'active' | 'paused' | 'access_suspended';

export interface TelegramStatusPayload {
  available: boolean;
  status: TelegramConnectionStatus;
  identity: {
    username: string | null;
    firstName: string | null;
  } | null;
  botUrl: string | null;
  linkedAt: string | null;
  lastDeliveryAt: string | null;
  lastError: {
    code: string;
    at: string | null;
  } | null;
}

export function fetchTelegramStatus(token?: string | null) {
  return apiFetch<TelegramStatusPayload>('/api/telegram/status', { token });
}

export function createTelegramLink(token?: string | null) {
  return apiFetch<{ deepLink: string; expiresAt: string }>('/api/telegram/link', {
    method: 'POST',
    token,
  });
}

export function disconnectTelegram(token?: string | null) {
  return apiFetch<TelegramStatusPayload>('/api/telegram/disconnect', {
    method: 'POST',
    token,
  });
}
