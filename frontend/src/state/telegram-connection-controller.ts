import {
  createTelegramLink as createTelegramLinkRequest,
  disconnectTelegram as disconnectTelegramRequest,
  fetchTelegramStatus,
  type TelegramStatusPayload,
} from '../services/api/telegram';
import type { AppState } from './app-state';

type TelegramConnectionState = AppState['telegram'];

export interface TelegramConnectionApi {
  fetchStatus(token?: string | null): Promise<TelegramStatusPayload>;
  createLink(token?: string | null): Promise<{ deepLink: string; expiresAt: string }>;
  disconnect(token?: string | null): Promise<TelegramStatusPayload>;
}

export interface TelegramConnectionController {
  refresh(): Promise<void>;
  createLink(): Promise<void>;
  disconnect(): Promise<void>;
  reset(): void;
}

interface TelegramConnectionControllerOptions {
  state: TelegramConnectionState;
  isAuthenticated(): boolean;
  notify(): void;
  createInitialState(): TelegramConnectionState;
  sessionToken?: string | null;
  api?: TelegramConnectionApi;
}

const defaultApi: TelegramConnectionApi = {
  fetchStatus: fetchTelegramStatus,
  createLink: createTelegramLinkRequest,
  disconnect: disconnectTelegramRequest,
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function createTelegramConnectionController({
  state,
  isAuthenticated,
  notify,
  createInitialState,
  sessionToken = null,
  api = defaultApi,
}: TelegramConnectionControllerOptions): TelegramConnectionController {
  function applyStatus(payload: TelegramStatusPayload) {
    Object.assign(state, {
      ...payload,
      loaded: true,
      loading: false,
      error: null,
    });
  }

  async function refresh() {
    if (state.loading || !isAuthenticated()) return;
    state.loading = true;
    state.error = null;
    notify();
    try {
      applyStatus(await api.fetchStatus(sessionToken));
    } catch (error) {
      state.error = errorMessage(error, 'Unable to load Telegram status');
    } finally {
      state.loading = false;
      notify();
    }
  }

  async function createLink() {
    if (state.mutating) return;
    state.mutating = true;
    state.error = null;
    notify();
    try {
      const link = await api.createLink(sessionToken);
      state.pendingDeepLink = link.deepLink;
      state.pendingDeepLinkExpiresAt = link.expiresAt;
    } catch (error) {
      state.error = errorMessage(error, 'Unable to connect Telegram');
    } finally {
      state.mutating = false;
      notify();
    }
  }

  async function disconnect() {
    if (state.mutating) return;
    state.mutating = true;
    state.error = null;
    notify();
    try {
      applyStatus(await api.disconnect(sessionToken));
      state.pendingDeepLink = null;
      state.pendingDeepLinkExpiresAt = null;
    } catch (error) {
      state.error = errorMessage(error, 'Unable to disconnect Telegram');
    } finally {
      state.mutating = false;
      notify();
    }
  }

  return {
    refresh,
    createLink,
    disconnect,
    reset() {
      Object.assign(state, createInitialState());
    },
  };
}
