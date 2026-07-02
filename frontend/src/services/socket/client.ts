import { io, type Socket } from 'socket.io-client';
import { resolveApiBase } from '../api/base';
import type { DashboardAlertEvent, TokenSparklineCandleItem } from '../api/catalog';

let socket: Socket | null = null;
const desiredMarketSubscriptions = new Set<string>();
let desiredLivePresence: {
  workspace: 'live';
  mode: 'foreground' | 'hidden' | 'inactive';
  hiddenGraceMs?: number;
} | null = null;

export interface MarketBucketUpdateEvent {
  address: string;
  pairAddress?: string | null;
  granularityMinutes: number;
  generatedAt?: string | null;
  candle: TokenSparklineCandleItem;
}

export function connectSocket(): Socket {
  if (socket) {
    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }

  socket = io(resolveApiBase(), {
    transports: ['websocket'],
    withCredentials: true,
  });

  return socket;
}

export function bindSocketLifecycle(options: {
  onRevoked: (reason: string) => void;
  onStatus?: (message: string) => void;
  onAlertEvent?: (payload: DashboardAlertEvent) => void;
  onMarketBucket?: (payload: MarketBucketUpdateEvent) => void;
}) {
  const current = connectSocket();

  current.off('connect');
  current.off('disconnect');
  current.off('connect_error');
  current.off('auth:revoked');
  current.off('alert:event');
  current.off('market:bucket');

  current.on('connect', () => {
    if (desiredLivePresence) {
      current.emit('live:presence', desiredLivePresence);
    }
    for (const address of desiredMarketSubscriptions) {
      current.emit('market:subscribe', { address });
    }
    options.onStatus?.('Socket connected.');
  });

  current.on('disconnect', (reason) => {
    options.onStatus?.(`Socket disconnected: ${reason}`);
  });

  current.on('connect_error', (error) => {
    options.onStatus?.(`Socket error: ${error.message}`);
  });

  current.on('auth:revoked', (payload?: { reason?: string }) => {
    options.onRevoked(payload?.reason || 'session_revoked');
  });

  current.on('alert:event', (payload: DashboardAlertEvent) => {
    options.onAlertEvent?.(payload);
  });

  current.on('market:bucket', (payload: MarketBucketUpdateEvent) => {
    options.onMarketBucket?.(payload);
  });

  return current;
}

export function subscribePumpMint(_mint: string) {
  return false;
}

export function unsubscribePumpMint(_mint: string) {
  return false;
}

export function subscribeMarketChart(address: string) {
  const normalized = String(address || '').trim();
  if (!normalized) {
    return false;
  }

  desiredMarketSubscriptions.add(normalized);
  connectSocket().emit('market:subscribe', { address: normalized });
  return true;
}

export function unsubscribeMarketChart(address: string) {
  const normalized = String(address || '').trim();
  if (!normalized) {
    return false;
  }

  desiredMarketSubscriptions.delete(normalized);
  socket?.emit('market:unsubscribe', { address: normalized });
  return true;
}

export function getSocket(): Socket | null {
  return socket;
}

export function getDesiredPumpSubscriptionCount() {
  return 0;
}

export function updateLivePresence(payload: {
  workspace: 'live';
  mode: 'foreground' | 'hidden' | 'inactive';
  hiddenGraceMs?: number;
}) {
  desiredLivePresence = payload.mode === 'hidden'
    ? {
        workspace: 'live',
        mode: 'hidden',
        hiddenGraceMs: Math.max(1, Math.trunc(Number(payload.hiddenGraceMs) || 0)),
      }
    : {
        workspace: 'live',
        mode: payload.mode,
      };

  if (!socket) {
    return;
  }

  socket.emit('live:presence', desiredLivePresence);
}

export function disconnectSocket() {
  desiredMarketSubscriptions.clear();
  socket?.disconnect();
}
